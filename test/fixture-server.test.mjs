import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFixtureServer } from '../scripts/fixture-server.mjs';

const within = (promise, ms) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(Error(`unsettled after ${ms} ms`)), ms).unref())]);

test('a server that exits during startup rejects promptly instead of hanging cleanup', async () => {
  await assert.rejects(within(startFixtureServer({ args: ['-e', 'process.exit(1)'] }), 5000), /fixture server exited 1/);
});

test('a server that never announces its URL times out and is reaped', async () => {
  await assert.rejects(within(startFixtureServer({ args: ['-e', 'setInterval(() => {}, 1000)'], startupMs: 200 }), 5000),
    /startup timeout/);
});

test('stop is bounded when the server ignores SIGTERM', async () => {
  const server = await within(startFixtureServer({ stopMs: 300, args: ['-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('http://127.0.0.1:1')"] }), 5000);
  assert.equal(server.url, 'http://127.0.0.1:1');
  await within(server.stop(), 5000);
  await within(server.stop(), 5000);
});

test('the real fixture server serves and stops', async () => {
  const server = await within(startFixtureServer(), 15000);
  assert.equal((await fetch(server.url + '/')).status, 200);
  await within(server.stop(), 10000);
});

const run = (file, args, { timeout, signal, ...options }) => {
  const child = spawn(file, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.resume();
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve({ stderr })
      : reject(Error(`fixture probe exited ${code ?? signal}: ${stderr}`)));
  });
  const stop = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const timer = setTimeout(stop, timeout);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  return Object.assign(result.finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    stop();
  }), { child });
};
const harness = new URL('./browser-harness.mjs', import.meta.url).href;
const probe = `
  import assert from 'node:assert/strict';
  const { fixtureServer } = await import(${JSON.stringify(harness)});
  const { options, expected } = JSON.parse(process.argv[1]);
  const server = await fixtureServer(options);
  try {
    assert.equal(new URL(server.origin).hostname, '127.0.0.1');
    assert.equal(new URL(server.origin).protocol, 'http:');
    assert.ok(Number(new URL(server.origin).port) > 0);
    const response = await fetch(server.origin + '/fixture-root-probe.txt');
    if (expected === null) {
      assert.equal(response.status, 404);
      assert.equal((await fetch(server.origin + '/')).status, 200);
    } else {
      assert.equal(response.status, 200);
      assert.equal(await response.text(), expected);
    }
  } finally {
    const closed = server.close();
    await closed;
    assert.equal(typeof closed?.then, 'function');
  }
  await assert.rejects(fetch(server.origin + '/', { signal: AbortSignal.timeout(1000) }));
  await server.close();
`;

for (const mode of ['default', 'ambient', 'explicit', 'empty']) {
  test(`fixture adapter preserves ${mode} root and awaits repeatable shutdown`, async t => {
    const directory = await temporaryDirectory(join(tmpdir(), 'doctorcre-fixture-adapter-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const ambient = join(directory, 'ambient');
    const explicit = join(directory, 'explicit');
    await Promise.all([mkdir(ambient), mkdir(explicit)]);
    await Promise.all([
      writeFile(join(ambient, 'fixture-root-probe.txt'), 'ambient synthetic root'),
      writeFile(join(explicit, 'fixture-root-probe.txt'), 'explicit synthetic root'),
    ]);
    const env = { ...process.env };
    delete env.DOCTORCRE_FIXTURE_ROOT;
    if (mode !== 'default') env.DOCTORCRE_FIXTURE_ROOT = ambient;
    const options = mode === 'explicit' ? { root: explicit } : mode === 'empty' ? { root: '' } : {};
    const expected = mode === 'default' ? null : mode === 'explicit' ? 'explicit synthetic root' : 'ambient synthetic root';
    const result = await run(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify({ options, expected })],
      { env, timeout: 20000, signal: t.signal });
    assert.equal(result.stderr, '');
  });
}

for (const cancellation of ['timeout', 'abort']) {
  test(`fixture probe ${cancellation} reaps its fixture and releases its port`, async () => {
    const controller = new AbortController();
    const result = run(process.execPath, ['--input-type=module', '-e', `
      const { fixtureServer } = await import(${JSON.stringify(harness)});
      const server = await fixtureServer();
      console.log('READY ' + server.origin);
      try { await new Promise(() => {}); } finally { await server.close(); }
    `], { timeout: 5000, signal: controller.signal });
    const finished = result.then(() => null, error => error);
    let fixturePid;
    try {
      const origin = await within(new Promise(resolve => {
        let output = '';
        result.child.stdout.on('data', data => {
          output += data;
          const match = output.match(/READY (http:\/\/127\.0\.0\.1:\d+)/);
          if (match) resolve(match[1]);
        });
      }), 4000);
      fixturePid = Number(execFileSync('pgrep', ['-P', String(result.child.pid)], { encoding: 'utf8' }).trim());
      assert.ok(fixturePid);
      if (cancellation === 'abort') controller.abort();
      assert.ok(await within(finished, 7000), 'cancellation must reject the probe');
      await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(1000) }), 'fixture port must be closed');
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(fixturePid, 0); } catch { break; }
        await delay(20);
      }
      assert.throws(() => process.kill(fixturePid, 0), { code: 'ESRCH' }, 'fixture process must be reaped');
    } finally {
      if (fixturePid) {
        try { process.kill(fixturePid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      result.child.kill('SIGKILL');
      await within(finished, 5000);
    }
  });
}
