import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './proof-fixture-server.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { uiAssets } from '../scripts/ui-bundle.mjs';
const assets = await uiAssets(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
const root = resolve('test/fixtures');
async function fixture(t, mode) {
  const seen = [];
  const files = new Map(assets);
  if (mode === 'assertion') files.set('js/ui-task-done.js', Buffer.from('export async function completeAction(){return {}}'));
  if (mode === 'network') files.set('js/ui-task-done.js', Buffer.from("await fetch('/business', {method:'POST'});"));
  if (mode === 'budget') {
    const names = Array.from({ length: 9 }, (_, i) => `ui-shared-AAAAA${i}.generated.js`);
    files.set('js/ui-task-done.js', Buffer.from(names.map(name => `import './${name}';`).join('\n')));
    for (const name of names) files.set('js/' + name, Buffer.from('export const synthetic = true;'));
  }
  const manifest = { schema: 'doctorcre-static-artifact.v1', repository: 'jbookout/doctorcre-app', source_commit: '1'.repeat(40), files: [...files].map(([path, data]) => ({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })) };
  if (mode === 'identity') manifest.source_commit = '2'.repeat(40);
  if (mode === 'wrong-asset') files.set('js/ui-task-done.js', Buffer.from('export const wrong = true;'));
  if (mode === 'cross-origin') manifest.files.find(row => row.path === 'js/ui-task-done.js').path = 'https://other.test/js/ui-task-done.js';
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    seen.push({ method: req.method, path: req.url });
    let path;
    try { path = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0])); } catch { res.writeHead(400); return res.end(); }
    if (!path.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    if (mode === 'timeout') return;
    if (req.url === '/app-release') return res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }));
    if (req.url === '/artifact-manifest.json') return res.end(mode === 'manifest' ? '{' : JSON.stringify(manifest));
    if (mode === 'unavailable') { res.writeHead(404); return res.end(); }
    const data = files.get(req.url.slice(1));
    if (!data) { res.writeHead(404); return res.end(); }
    res.setHeader('content-type', 'text/javascript');
    res.end(data);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
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
  assert.ok(result.receipt.assets.some(row => row.url.endsWith('/js/ui-task-done.js')));
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
  assert.equal(response.status, 403);
});
