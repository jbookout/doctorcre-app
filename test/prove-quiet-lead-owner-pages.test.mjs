import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { prove } from '../scripts/prove-quiet-lead-owner-pages.mjs';
import { assertProofDeadlineCleanup } from './proof-browser-harness.mjs';
const run = promisify(execFile), commit = '1'.repeat(40), descendant = '2'.repeat(40);
const args = ['scripts/prove-quiet-lead-owner-pages.mjs', '--fixture', '--expected-commit', commit];
test('fixture CLI passes and containing release assertion failure exits 1', async t => {
  const result = await run(process.execPath, args);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const root = temporaryDirectory('quiet-proof-', t), path = join(root, 'bad.json');
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
  snapshot.proposals[0].owner = 1; await writeFile(path, JSON.stringify(snapshot));
  await assert.rejects(run(process.execPath, [...args, '--recording', path]), error => error.code === 1);
});
for (const kind of ['equal', 'descendant', 'older', 'unrelated', 'unknown']) test(`release ${kind}`, async () => {
  const source = kind === 'equal' ? commit : kind === 'unknown' ? undefined : descendant;
  const options = { fixture: true, expectedCommit: commit, readRelease: async () => ({ source_commit: source }), ancestry: async () => kind === 'descendant' };
  if (['equal', 'descendant'].includes(kind)) assert.equal((await prove(options)).ok, true);
  else await assert.rejects(prove(options), { exitCode: 78 });
});
test('unreachable CDP session exits 78 after verifying a containing release', async t => {
  let releaseReads = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, '/app-release');
    releaseReads++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: commit }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(run(process.execPath, [args[0], '--origin', `http://127.0.0.1:${server.address().port}`,
    '--expected-commit', commit, '--cdp-url', 'http://127.0.0.1:1', '--timeout-ms', '5000']), error => {
    assert.equal(error.code, 78);
    assert.equal(JSON.parse(error.stdout).status, 'insufficient_evidence');
    assert.match(JSON.parse(error.stdout).error, /ECONNREFUSED/);
    return true;
  });
  assert.equal(releaseReads, 1);
});
test('missing session is insufficient evidence', async () => {
  await assert.rejects(prove({ expectedCommit: commit, readRelease: async () => ({ source_commit: commit }) }), { exitCode: 78 });
});
test('no natural subjects is insufficient evidence', async t => {
  const root = temporaryDirectory('quiet-empty-', t), path = join(root, 'empty.json');
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
  snapshot.proposals = []; await writeFile(path, JSON.stringify(snapshot));
  await assert.rejects(prove({ fixture: true, expectedCommit: commit, recordingUrl: path }), { exitCode: 78 });
});
for (const mode of ['late launch', 'stalled evaluation']) test(`deadline cleanup ${mode}`, async t => {
  await assertProofDeadlineCleanup(t, { entry: args[0], args: args.slice(1), mode, timeoutMs: 2000 });
});

test('natural proof borrows a CDP session and leaves its browser running', async t => {
  const { createServer } = await import('node:net');
  const { chromium } = await import('playwright');
  const { CHROMIUM_SAFETY_ARGS } = await import('../scripts/chromium-safety-args.mjs');
  const { routeLeads } = await import('./leads-browser-fixture.mjs');
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const owned = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS, `--remote-debugging-port=${port}`] });
  t.after(() => owned.close());
  const recording = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
  let borrowed;
  const engine = { connectOverCDP: async (endpoint, options) => {
    borrowed = await chromium.connectOverCDP(endpoint, options);
    const context = borrowed.contexts()[0];
    await routeLeads(context);
    await context.route('**/mcp', (route, request) => request.postDataJSON()?.params?.name === 'quiet-follow-ups' ? route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(recording) }] } } }) : route.fallback());
    return borrowed;
  } };
  const result = await prove({ expectedCommit: commit, origin: 'http://localhost', cdpUrl: `http://127.0.0.1:${port}`, engine, readRelease: async () => ({ source_commit: commit }) });
  assert.equal(result.mode, 'natural');
  assert.equal(result.ok, true);
  assert.equal(borrowed.isConnected(), false, 'proof disconnects its CDP connection');
  assert.equal(owned.isConnected(), true, 'shared browser process stays alive');
  assert.equal((await owned.newPage()).isClosed(), false, 'shared browser remains usable');
});

test('one total deadline includes release reads', async () => {
  await assert.rejects(prove({ expectedCommit: commit, timeoutMs: 20, readRelease: () => new Promise(() => {}) }), { exitCode: 78 });
});


test('missing expected commit remains insufficient evidence regardless of argument order', async () => {
  for (const options of [['--fixture'], ['--origin', 'http://localhost', '--timeout-ms', '1']]) {
    await assert.rejects(run(process.execPath, [args[0], ...options]), error => error.code === 78 && /Expected merge commit required/.test(error.stdout));
  }
});
