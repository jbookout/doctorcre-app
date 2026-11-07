import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { collectScriptResponses } from '../scripts/measure-performance.mjs';

const response = (body, options = {}) => ({ request: () => ({ resourceType: () => options.type || 'script' }),
  ok: () => options.ok !== false, url: () => options.url || 'http://localhost/app.js', body });

test('drain stops late callbacks before context teardown and settles accepted reads', async () => {
  const page = new EventEmitter();
  const collector = collectScriptResponses(page);
  let release;
  page.emit('response', response(() => new Promise(resolve => { release = resolve; })));
  let settled = false;
  const finish = collector.finish().then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  let lateRead = false;
  page.emit('response', response(async () => { lateRead = true; throw Error('Target page, context or browser has been closed'); }));
  release(Buffer.from('abc'));
  assert.deepEqual([...await finish], [['http://localhost/app.js', 3]]);
  assert.equal(lateRead, false);
});

test('closed-context body rejections are handled immediately even before drain', async () => {
  const page = new EventEmitter();
  const collector = collectScriptResponses(page);
  page.emit('response', response(async () => { throw Error('response.body: Target page, context or browser has been closed'); }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await collector.finish()).size, 0);
});

test('script transport and HTTP failures fail measurement without unhandled rejections', async () => {
  for (const entry of [response(async () => { throw Error('protocol unavailable'); }), response(async () => Buffer.alloc(1), { ok: false })]) {
    const page = new EventEmitter();
    const collector = collectScriptResponses(page);
    page.emit('response', entry);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(collector.finish(), /protocol unavailable|script failed/);
  }
});

test('non-script responses are ignored and script URLs are counted once', async () => {
  const page = new EventEmitter();
  const collector = collectScriptResponses(page);
  page.emit('response', response(async () => { throw Error('not a script'); }, { type: 'image' }));
  page.emit('response', response(async () => Buffer.from('abc')));
  page.emit('response', response(async () => Buffer.from('abc')));
  assert.equal((await collector.finish()).size, 1);
});

test('aborted measurement publishes screen failure and exits 3, including setup errors', t => {
  const root = temporaryDirectory('perf-recorder-', t);
  const script = new URL('../scripts/measure-performance.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { measurePerformance } from ${JSON.stringify(script)};
    await measurePerformance({ root: ${JSON.stringify(root)} });
  `], { encoding: 'utf8' });
  assert.equal(run.status, 3, run.stderr);
  const summary = readFileSync(join(root, 'test-artifacts/performance/summary.md'), 'utf8');
  assert.match(summary, /Measurement failed/);
  assert.match(summary, /Screen: setup/);
  assert.match(summary, /ENOENT/);
});

test('summary publication handles absent measurement output explicitly', t => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const step = ci.split('      - name: Publish performance summary\n')[1].split('\n\n')[0];
  const shell = step.split('        run: |\n')[1].replace(/^          /gm, '');
  const root = temporaryDirectory('perf-summary-', t);
  for (const exists of [false, true]) {
    if (exists) {
      // The artifact is produced by the real measurement failure path above.
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { measurePerformance } from ${JSON.stringify(new URL('../scripts/measure-performance.mjs', import.meta.url).href)};
        await measurePerformance({ root: ${JSON.stringify(root)} });
      `]);
      assert.equal(run.status, 3);
    }
    const output = join(root, 'published.md');
    writeFileSync(output, '');
    const run = spawnSync('bash', ['-e', '-c', shell], { cwd: root, env: { ...process.env, GITHUB_STEP_SUMMARY: output }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(output, 'utf8'), /Measurement failed/);
  }
});

test('interrupted Home navigation publishes its screen and closes owned resources', t => {
  const root = temporaryDirectory('perf-interrupted-', t);
  mkdirSync(join(root, 'contracts'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'contracts/performance-budget.v1.json'),
    readFileSync(new URL('../contracts/performance-budget.v1.json', import.meta.url)));
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  const archive = Buffer.from('synthetic build');
  writeFileSync(join(root, 'dist/doctorcre-app.tar'), archive);
  writeFileSync(join(root, 'dist/doctorcre-app.tar.sha256'),
    `${createHash('sha256').update(archive).digest('hex')}  doctorcre-app.tar`);
  writeFileSync(join(root, 'dist/doctorcre-app.manifest.json'), JSON.stringify({ source_commit: sourceCommit, files: [] }));
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { measurePerformance } from ${JSON.stringify(new URL('../scripts/measure-performance.mjs', import.meta.url).href)};
    const closed = [];
    const page = Object.assign(new EventEmitter(), {
      clock: { setFixedTime: async () => {} }, setDefaultTimeout() {}, addInitScript: async () => {},
      goto: async () => { throw Error('navigation interrupted'); },
    });
    const context = { newPage: async () => page, newCDPSession: async () => ({ send: async () => {} }),
      tracing: { start: async () => {}, stop: async () => { closed.push('trace'); } },
      close: async () => { closed.push('context'); } };
    await measurePerformance({ root: ${JSON.stringify(root)},
      startServer: async () => ({ url: 'http://localhost', stop: async () => { closed.push('server'); } }),
      launchBrowser: async () => ({ newContext: async () => context, close: async () => { closed.push('browser'); } }),
    });
    assert.deepEqual(closed, ['trace', 'context', 'browser', 'server']);
    assert.equal(page.listenerCount('response'), 0);
  `], { env: { ...process.env, GIT_DIR: gitDir }, encoding: 'utf8' });
  assert.equal(run.status, 3, run.stderr);
  const summary = readFileSync(join(root, 'test-artifacts/performance/summary.md'), 'utf8');
  assert.match(summary, /Measurement failed/);
  assert.match(summary, /Screen: home/);
  assert.match(summary, /navigation interrupted/);
});
