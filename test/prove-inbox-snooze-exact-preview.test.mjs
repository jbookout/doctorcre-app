import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from './proof-fixture-server.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { prove } from '../scripts/prove-inbox-snooze-exact-preview.mjs';
let out;
before(async () => { out = await temporaryDirectory('snooze-proof-'); await buildArtifact({ root: process.cwd(), outDir: out }); });
after(async () => { if (out) await rm(out, { recursive: true, force: true }); });
async function server(t, broken = false) {
  const root = resolve(out, 'site');
  const app = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture.invalid').pathname;
    if (path === '/app-release') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: 'a'.repeat(40) })); }
    const file = resolve(root, '.' + decodeURIComponent(path));
    if (!file.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    try {
      let body = await readFile(file);
      if (broken && path === '/js/ui-inbox.js') body = Buffer.from(body.toString().replaceAll('America/Chicago', 'UTC'));
      res.writeHead(200, { 'content-type': ['.js', '.mjs'].includes(extname(file)) ? 'text/javascript' : 'text/plain' }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  return `http://127.0.0.1:${app.address().port}`;
}
function cli(origin, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/prove-inbox-snooze-exact-preview.mjs', '--origin', origin, '--timeout-ms', String(timeout)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', code => resolve({ code, receipt: JSON.parse(stdout), stderr }));
  });
}
test('CLI fixture passes deployed assertions but natural acceptance exits 78', async t => {
  const result = await cli(await server(t));
  assert.equal(result.code, 78, result.stderr);
  assert.equal(result.receipt.ok, true, JSON.stringify(result.receipt));
  assert.equal(result.receipt.deployed_module.mutation_requests, 0);
  assert.equal(result.receipt.natural.status, 'insufficient_evidence');
});
test('CLI broken deployed fixture cannot pass', async t => {
  const result = await cli(await server(t, true), 15000);
  assert.equal(result.receipt.ok, false);
  assert.equal(result.code, 1);
});
test('late launch closes its acquired browser after deadline with no survivor', async t => {
  const origin = await server(t);
  let live = 0;
  const engine = { async launch() { await new Promise(resolve => setTimeout(resolve, 100)); live++; return { async close() { live = 0; } }; } };
  await assert.rejects(prove({ origin, timeoutMs: 30, engine }), error => error.name === 'TimeoutError' || error.exitCode === 78);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(live, 0);
});
test('stalled evaluation closes only the acquired browser on deadline', async t => {
  const origin = await server(t);
  let live = 0;
  const locator = { first() { return this; }, async click() {}, locator() { return this; }, evaluateAll() { return new Promise(() => {}); } };
  const page = { setDefaultTimeout() {}, clock: { async setFixedTime() {} }, async route() {}, async goto() {}, getByRole() { return locator; } };
  const engine = { async launch() { live++; return { async newContext() { return { async route() {}, async newPage() { return page; } }; }, async close() { live = 0; } }; } };
  await assert.rejects(prove({ origin, timeoutMs: 100, engine }), error => error.name === 'TimeoutError' || error.exitCode === 78);
  assert.equal(live, 0);
});
