import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createServer } from './proof-fixture-server.mjs';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { prove } from '../scripts/prove-fact-review-term-key-filter.mjs';
const root = resolve(new URL('../', import.meta.url).pathname);
const assets = await uiAssets(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
async function fixture(t, mode = 'healthy') {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    let path;
    if (/%(?:2e|5c|00)/i.test(req.url)) { res.writeHead(403); return res.end(); }
    try { path = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(403); return res.end(); }
    if (/[\\\0]/.test(path)) { res.writeHead(403); return res.end(); }
    const target = resolve(root, `.${path}`);
    if (!target.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    if (path === '/app-release') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }));
    }
    if (mode === 'protected') { res.writeHead(403); return res.end(); }
    res.setHeader('content-type', 'text/javascript');
    if (path === '/js/ui-facts.js' && mode === 'broken') return res.end('export function mountFactReview(){throw Error("broken module")}');
    if (path === '/js/ui-facts.js' && mode === 'stall') return res.end('await new Promise(()=>{});');
    readFile(target).then(body => res.end(assets.get(path.slice(1)) || body)).catch(() => { res.writeHead(404); res.end(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}
async function cli(origin, fixture = true, timeoutMs = 30000) {
  const child = spawn(process.execPath, ['scripts/prove-fact-review-term-key-filter.mjs', '--origin', origin, '--timeout-ms', String(timeoutMs), ...(fixture ? ['--fixture'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, receipt: JSON.parse(stdout.trim()), stderr };
}
test('fixture CLI passes the recorded module observation', async t => {
  const f = await fixture(t), result = await cli(f.origin);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.receipt.status, 'passed');
  assert.ok(result.receipt.assertions.includes('local-selection-never-reads'));
  assert.ok(f.seen.every(path => path === '/app-release' || path.startsWith('/js/')));
});
for (const [mode, code] of [['broken', 1], ['protected', 78], ['stall', 78]]) {
  test(`${mode} CLI exits without a passing receipt`, async t => {
    const f = await fixture(t, mode), result = await cli(f.origin, true, mode === 'stall' ? 1500 : 30000);
    assert.equal(result.code, code, JSON.stringify(result));
    assert.notEqual(result.receipt.status, 'passed');
  });
}
test('fresh browser reports natural insufficient_evidence exit 78', async t => {
  const f = await fixture(t), result = await cli(f.origin, false);
  assert.equal(result.code, 78, JSON.stringify(result));
  assert.equal(result.receipt.status, 'insufficient_evidence');
});
for (const mode of ['late launch', 'stalled evaluation']) {
  test(`${mode} closes every acquired browser`, async t => {
    const f = await fixture(t);
    let acquired = 0, closed = 0;
    const engine = { launch: async () => {
      acquired++;
      if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 250));
      return { close: async () => { closed++; }, newPage: async () => ({ route: async () => {}, goto: async () => {}, evaluate: () => new Promise(() => {}) }) };
    } };
    await assert.rejects(prove({ origin: f.origin, fixture: true, timeoutMs: 100, engine }), error => error.exitCode === 78);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(acquired, 1); assert.ok(closed >= acquired, 'zero owned browser survivors');
  });
}
test('fixture HTTP refuses raw and encoded traversal with an empty body', async t => {
  const f = await fixture(t);
  for (const path of [
    '/../package.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json',
    '/%2e%2e%2fWR39-S22-J4-sibling/file', '/js/%2e/client.js',
    '/js/%5cclient.js', '/js/\\client.js', '/js/client.js%00', '/js/%zz',
  ]) {
    const response = await new Promise((resolve, reject) => {
      get(f.origin, { path }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    assert.deepEqual(response, { status: 403, body: '' }, path);
  }
});
for (const mode of ['late launch', 'stalled evaluation']) {
  test(`real Chromium ${mode} leaves zero owned survivors`, async t => {
    const f = await fixture(t, mode === 'stalled evaluation' ? 'stall' : 'healthy');
    const { chromium } = await import('playwright');
    const owned = [];
    const engine = { launch: async options => {
      const browser = await chromium.launch(options); owned.push(browser);
      if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 1500));
      return browser;
    } };
    await assert.rejects(prove({ origin: f.origin, fixture: true, timeoutMs: 1000, engine }), error => error.exitCode === 78);
    assert.equal(owned.length, 1);
    assert.ok(owned.every(browser => !browser.isConnected()), 'zero owned browser survivors');
  });
}
