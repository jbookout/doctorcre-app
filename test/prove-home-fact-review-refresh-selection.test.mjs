import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';

const root = process.cwd();
const assets = await uiAssets(path => readFile(resolve(root, path), 'utf8'));
async function fixture(t, mode) {
  const seen = [];
  let identities = 0;
  const server = createServer(async (req, res) => {
    seen.push({ method: req.method, path: req.url });
    if (mode === 'timeout') return;
    if (req.url === '/app-release') {
      const response = await handleDoctorcreRequest(new Request('https://app.doctorcre.com/app-release'), { APP_ENV: 'production', GIT_SHA: mode === 'changed' && identities++ ? '2'.repeat(40) : '1'.repeat(40) });
      res.setHeader('content-type', 'application/json');
      return res.end(mode === 'identity' ? '{}' : await response.text());
    }
    if (mode === 'budget' && req.url.startsWith('/js/')) {
      const n = req.url === '/js/ui-inbox.js' ? 0 : Number(req.url.match(/budget-(\d+)/)?.[1]) + 1;
      res.setHeader('content-type', 'text/javascript'); return res.end(`import './budget-${n}.js';`);
    }
    if (mode === 'unavailable') { res.writeHead(404); return res.end(); }
    if (req.url === '/js/ui-inbox.js' && mode === 'broken') { res.setHeader('content-type', 'text/javascript'); return res.end('throw Error("contradictory fixture")'); }
    if (req.url === '/js/ui-inbox.js' && mode === 'network') { res.setHeader('content-type', 'text/javascript'); return res.end('await fetch("/api/business", {method:"POST"})'); }
    let path;
    try { path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname)); } catch { res.writeHead(400); return res.end(); }
    if (!path.startsWith(root + sep) || !req.url.startsWith('/js/')) { res.writeHead(403); return res.end(); }
    const body = assets.get(req.url.slice(1)) || await readFile(path).catch(() => null);
    if (!body) { res.writeHead(404); return res.end(); }
    res.setHeader('content-type', 'text/javascript'); res.end(body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}
async function cli(origin, flags = []) {
  const child = spawn(process.execPath, ['scripts/prove-home-fact-review-refresh-selection.mjs', '--origin', origin, '--timeout-ms', '30000', ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const [code] = await once(child, 'close');
  return { code, receipt: JSON.parse(stdout.trim()), stderr };
}
test('proof CLI boots deployed entry, checks fresh requests, empty evidence and reload failure', async t => {
  const f = await fixture(t, 'pass');
  const { code, receipt } = await cli(f.origin);
  console.log(JSON.stringify({ mode: 'pass', code, receipt }));
  assert.equal(code, 0, JSON.stringify(receipt));
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.release.source_commit, '1'.repeat(40));
  assert.equal(receipt.business_network_writes, 0);
  assert.ok(receipt.assertions.some(a => a.startsWith('replaced: request contains')));
  assert.ok(receipt.assertions.some(a => a.startsWith('empty: request contains')));
  assert.ok(receipt.assertions.some(a => a.startsWith('reload-failure:')));
  assert.ok(receipt.assets.length > 1 && receipt.assets.length <= 20);
  assert.ok(receipt.assets.every(a => /^[a-f0-9]{64}$/.test(a.sha256)));
  assert.ok(f.seen.every(r => r.method === 'GET' && (r.path === '/app-release' || r.path.startsWith('/js/'))));
});
for (const [mode, expected] of [['budget', 1], ['broken', 1], ['network', 1], ['changed', 1], ['identity', 78], ['unavailable', 78], ['timeout', 78]]) {
  test(`proof CLI refuses ${mode} with identical production flags`, { timeout: 40000 }, async t => {
    const f = await fixture(t, mode);
    const { code, receipt } = await cli(f.origin);
    console.log(JSON.stringify({ mode, code, receipt }));
    assert.equal(code, expected, JSON.stringify(receipt));
    assert.notEqual(receipt.status, 'passed');
    if (mode === 'budget') { assert.match(receipt.error, /Asset request budget/); assert.equal(f.seen.filter(r => r.path.startsWith('/js/')).length, 20); }
    assert.ok(f.seen.every(r => r.method === 'GET'));
  });
}
test('proof CLI rejects unknown flags', async t => {
  const f = await fixture(t, 'pass');
  assert.equal((await cli(f.origin, ['--retry'])).code, 1);
  assert.equal(f.seen.length, 0);
});
