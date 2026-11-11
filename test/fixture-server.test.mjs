import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixtureProbe } from './fixture-probe.ts';
import { startFixtureServer } from '../scripts/fixture-server.mjs';

test('a server that exits during startup rejects promptly instead of hanging cleanup', { timeout: 60000 }, async () => {
  await assert.rejects(startFixtureServer({ args: ['-e', 'process.exit(1)'] }), /fixture server exited 1/);
});

test('a server that never announces its URL times out and is reaped', { timeout: 60000 }, async () => {
  await assert.rejects(startFixtureServer({ args: ['-e', 'setInterval(() => {}, 1000)'], startupMs: 200 }),
    /startup timeout/);
});

test('stop is bounded when the server ignores SIGTERM', { timeout: 60000 }, async () => {
  const server = await startFixtureServer({ stopMs: 300, args: ['-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('http://127.0.0.1:1')"] });
  assert.equal(server.url, 'http://127.0.0.1:1');
  await server.stop();
  await server.stop();
});

test('the real fixture server serves and stops', { timeout: 60000 }, async () => {
  const server = await startFixtureServer();
  assert.equal((await fetch(server.url + '/')).status, 200);
  await server.stop();
});

for (const mode of ['default', 'ambient', 'explicit', 'empty', 'conflicting colors']) {
  test(`fixture adapter preserves ${mode} root and awaits repeatable shutdown`, { timeout: 60000 }, async t => {
    const directory = await temporaryDirectory('doctorcre-fixture-adapter-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const ambient = join(directory, 'ambient');
    const explicit = join(directory, 'explicit');
    await Promise.all([mkdir(ambient), mkdir(explicit)]);
    await Promise.all([
      writeFile(join(ambient, 'fixture-root-probe.txt'), 'ambient synthetic root'),
      writeFile(join(explicit, 'fixture-root-probe.txt'), 'explicit synthetic root'),
    ]);
    for (const [root, body] of [[ambient,'ambient synthetic root'],[explicit,'explicit synthetic root']]) {
      await writeFile(join(root,'artifact-manifest.json'),JSON.stringify({
        schema:'doctorcre-static-artifact.v1',repository:'jbookout/doctorcre-app',source_commit:'0'.repeat(40),
        files:[{path:'fixture-root-probe.txt',bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}],
      }));
      await writeFile(join(root,'unadmitted.txt'),'not part of this snapshot');
    }
    const env = { ...process.env };
    delete env.DOCTORCRE_FIXTURE_ROOT;
    if (mode !== 'default' && mode !== 'conflicting colors') env.DOCTORCRE_FIXTURE_ROOT = ambient;
    if (mode === 'conflicting colors') { env.FORCE_COLOR = '1'; env.NO_COLOR = '1'; }
    const options = mode === 'explicit' ? { root: explicit } : mode === 'empty' ? { root: '' } : {};
    const expected = mode === 'default' || mode === 'conflicting colors' ? null : mode === 'explicit' ? 'explicit synthetic root' : 'ambient synthetic root';
    const probe = fixtureProbe({ ...options, expected, env, signal: t.signal });
    t.after(() => probe.close());
    const result = await probe.exercise('adapter');
    assert.equal(result.stderr, '');
  });
}

for (const cancellation of ['timeout', 'abort']) {
  test(`fixture probe ${cancellation} reaps its fixture and releases its port after delayed acquisition`, { timeout: 60000 }, async t => {
    const directory = await temporaryDirectory('doctorcre-fixture-cancel-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, 'artifact-manifest.json'), JSON.stringify({
      schema: 'doctorcre-static-artifact.v1', repository: 'jbookout/doctorcre-app', source_commit: '0'.repeat(40), files: [],
    }));
    const probe = fixtureProbe({ root: directory, delayMs: 4200, signal: t.signal });
    t.after(() => probe.close());
    const { origin, fixturePid } = await probe.ready;
    await assert.rejects(probe.exercise(cancellation), new RegExp(`exercise ${cancellation}`));
    await probe.close();
    await assert.rejects(fetch(origin), 'fixture port must be closed');
    assert.throws(() => process.kill(fixturePid, 0), { code: 'ESRCH' }, 'fixture process must be reaped');
    assert.throws(() => process.kill(probe.pid, 0), { code: 'ESRCH' }, 'probe process must be reaped');
  });
}
