import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { uiAssets } from '../scripts/ui-bundle.mjs';
const assets = await uiAssets(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
async function fixture(t, mode) {
  const files = new Map(assets);
  if (mode === 'assertion') files.set('js/ui-task-done.generated.js', Buffer.from('export async function completeAction(){return {}}'));
  if (mode === 'network') files.set('js/ui-task-done.generated.js', Buffer.from("await fetch('/business', {method:'POST'});"));
  if (mode === 'budget') {
    const names = Array.from({ length: 9 }, (_, i) => `ui-shared-AAAAA${i}.generated.js`);
    files.set('js/ui-task-done.generated.js', Buffer.from(names.map(name => `import './${name}';`).join('\n')));
    for (const name of names) files.set('js/' + name, Buffer.from('export const synthetic = true;'));
  }
  const manifest = { schema: 'doctorcre-static-artifact.v1', repository: 'jbookout/doctorcre-app', source_commit: '1'.repeat(40), files: [...files].map(([path, data]) => ({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })) };
  if (mode === 'canonical') manifest.repository = 'DoctorCRE/doctorcre-app';
  if (mode === 'unrelated') manifest.repository = 'DoctorCRE/other';
  if (mode === 'identity') manifest.source_commit = '2'.repeat(40);
  if (mode === 'wrong-asset') files.set('js/ui-task-done.generated.js', Buffer.from('export const wrong = true;'));
  if (mode === 'cross-origin') manifest.files.find(row => row.path === 'js/ui-task-done.generated.js').path = 'https://other.test/js/ui-task-done.generated.js';
  const responses = new Map([...files].map(([path, body]) => ['/' + path, mode === 'unavailable' ? { status: 404 } : { body, contentType: 'text/javascript' }]));
  responses.set('/app-release', { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }) });
  responses.set('/artifact-manifest.json', { contentType: 'application/json', body: mode === 'manifest' ? '{' : JSON.stringify(manifest) });
  if (mode === 'timeout') for (const [path, response] of responses) responses.set(path, { ...response, hold: 'timeout' });
  const server = await startFixture({ routes: responses });
  t.after(() => server.close());
  return { origin: server.origin, get seen() { return server.requests; } };
}

async function cli(origin, timeout = '30000') {
  const child = spawn(process.execPath, ['scripts/prove-task-completion-event-required.mjs', '--origin', origin, '--timeout-ms', timeout], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, receipt: JSON.parse(stdout.trim()), stderr };
}
test('proof CLI executes manifest-selected module and emits every assertion', async t => {
  const f = await fixture(t);
  const result = await cli(f.origin);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.receipt.assertions.length, 15);
  assert.ok(result.receipt.assets.some(row => row.url.endsWith('/js/ui-task-done.generated.js')));
  assert.ok(result.receipt.assets.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
  assert.ok(f.seen.length <= 10);
  assert.ok(f.seen.every(row => row.method === 'GET'));
  assert.ok(!f.seen.some(row => row.path === '/business'));
});
for (const [mode, code] of [['manifest', 1], ['identity', 1], ['budget', 1], ['network', 1], ['wrong-asset', 1], ['cross-origin', 1], ['assertion', 1], ['unavailable', 78], ['timeout', 78]]) test(`proof CLI refuses ${mode}`, async t => {
  const f = await fixture(t, mode), result = await cli(f.origin, mode === 'timeout' ? '100' : '30000');
  assert.equal(result.code, code, JSON.stringify(result));
  assert.notEqual(result.receipt.status, 'passed');
  assert.ok(f.seen.length <= 10);
  assert.ok(f.seen.every(row => row.method === 'GET'));
  assert.ok(!f.seen.some(row => row.path === '/business'));
});
test('fixture refuses encoded traversal outside its root', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin + '/%2e%2e%2fprivate');
  assert.equal(response.status, 400);
});

for (const [mode, expected] of [['canonical', 0], ['unrelated', 1]]) test(`manifest repository ${mode}`, async t => {
  const f = await fixture(t, mode), result = await cli(f.origin);
  assert.equal(result.code, expected, JSON.stringify(result));
});
