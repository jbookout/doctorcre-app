import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from './proof-fixture-server.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { prove } from '../scripts/prove-quick-switcher-kind-filter.mjs';
function cli(origin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/prove-quick-switcher-kind-filter.mjs', '--origin', origin, '--timeout-ms', '5000']);
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value);
    child.stderr.on('data', value => stderr += value);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
async function fixture(t, upstream, fail = false) {
  const server = createServer(async (request, response) => {
    if (request.url === '/app-release') { response.setHeader('content-type', 'application/json'); return response.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) })); }
    if (fail) { response.setHeader('content-type', 'text/javascript'); return response.end('export function openQuickSwitcher() { throw Error("Broken deployed fixture"); }'); }
    const result = await fetch(upstream.url + request.url);
    response.writeHead(result.status, { 'content-type': result.headers.get('content-type') });
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('CLI passing fixture proves module only and failing fixture fails assertions', async t => {
  const upstream = await startFixtureServer();
  t.after(upstream.stop);
  const passing = await cli(await fixture(t, upstream));
  assert.equal(passing.code, 78, passing.stdout + passing.stderr);
  const receipt = JSON.parse(passing.stdout);
  assert.equal(receipt.deployed_module, 'pass');
  assert.equal(receipt.natural_acceptance, 'insufficient_evidence');
  assert.equal(receipt.fixture_assertions.business_reads, 1);
  const failing = await cli(await fixture(t, upstream, true));
  assert.equal(failing.code, 1, failing.stdout + failing.stderr);
  assert.match(JSON.parse(failing.stdout).error, /Broken deployed fixture/);
});
for (const mode of ['late launch', 'stalled evaluation']) test(`deadline disposes ${mode} without retained browser handles`, async t => {
  const origin = new URL(await fixture(t, null));
  let open = 0;
  const engine = { launch: async () => {
    if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 150));
    open++;
    let closed = false;
    return { close: async () => { if (!closed) { closed = true; open--; } }, newContext: async () => ({
      setDefaultTimeout() {}, route: async () => {}, newPage: async () => ({ goto: async () => {}, evaluate: () => new Promise(() => {}) }),
    }) };
  } };
  const result = await prove({ origin, timeout: 75, engine });
  assert.equal(result.code, 78);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(open, 0);
});
for (const mode of ['late launch', 'stalled evaluation']) test(`real browser closes after ${mode}`, async t => {
  const { chromium } = await import('playwright');
  const origin = new URL(await fixture(t, null));
  let acquired;
  let launched;
  const launchSettled = new Promise(resolve => launched = resolve);
  const engine = { launch: async options => {
    acquired = await chromium.launch(options);
    if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 400));
    else {
      const newContext = acquired.newContext.bind(acquired);
      acquired.newContext = async options => {
        const context = await newContext(options);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          page.evaluate = async () => new Promise(() => {});
          return page;
        };
        return context;
      };
    }
    launched();
    return acquired;
  } };
  try {
    const result = await prove({ origin, timeout: mode === 'late launch' ? 200 : 1000, engine });
    assert.equal(result.code, 78);
    await launchSettled;
    for (let i = 0; i < 20 && acquired.isConnected(); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(acquired.isConnected(), false);
  } finally { await acquired?.close(); }
});
