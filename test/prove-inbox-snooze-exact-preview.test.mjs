import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { startFixture } from '../scripts/fixture-http.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove } from '../scripts/prove-inbox-snooze-exact-preview.mjs';
let out, manifest;
before(async () => { out = await temporaryDirectory('snooze-proof-'); ({ manifest } = await buildArtifact({ root: process.cwd(), outDir: out })); });
after(async () => { if (out) await rm(out, { recursive: true, force: true }); });
async function server(t, broken = false) {
  const root = resolve(out, 'site');
  const responses = await loadFixtureAssets({ root, manifest: new Map(manifest.files.filter(row => row.path.startsWith('js/')).map(row => ['/' + row.path, row.path])) });
  responses.set('/app-release', { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: 'a'.repeat(40) }) });
  if (broken) responses.set('/js/ui-inbox.js', { ...responses.get('/js/ui-inbox.js'), body: responses.get('/js/ui-inbox.js').body.toString().replaceAll('America/Chicago', 'UTC') });
  const fixture = await startFixture({ routes: responses });
  t.after(() => fixture.close());
  return fixture.origin;
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
for (const delayedRelease of [false, true]) test(delayedRelease ? 'release deadline before acquisition launches no browser' : 'late launch closes its acquired browser after deadline with no survivor', { timeout: 20000 }, async t => {
  if (delayedRelease) {
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (...args) => {
      if (new URL(String(args[0])).pathname === '/app-release') await new Promise(resolve => setTimeout(resolve, 60));
      return fetch(...args);
    });
  }
  const origin = await server(t);
  let browser;
  let disposed;
  const closed = new Promise(resolve => { disposed = resolve; });
  const engine = { async launch(options) {
    browser = await chromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])], timeout: 15000 });
    await new Promise(resolve => setTimeout(resolve, 100));
    return new Proxy(browser, { get(target, key) {
      if (key === 'close') return async () => { await target.close(); disposed(); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  t.after(async () => { await browser?.close(); });
  await assert.rejects(prove({ origin, timeoutMs: 30, engine }), error => error.name === 'TimeoutError' || error.exitCode === 78);
  await closed;
  assert.equal(browser.isConnected(), false);
});
test('stalled evaluation closes only the acquired browser on deadline', async t => {
  const origin = await server(t);
  let browser, stalled = false;
  const wrapLocator = locator => new Proxy(locator, { get(target, key) {
    if (key === 'evaluateAll') return () => { stalled = true; return new Promise(() => {}); };
    if (key === 'locator') return (...args) => wrapLocator(target.locator(...args));
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const engine = { async launch(options) {
    browser = await chromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] });
    return new Proxy(browser, { get(target, key) {
      if (key === 'newContext') return async (...args) => {
        const context = await target.newContext(...args);
        return new Proxy(context, { get(target, key) {
          if (key === 'newPage') return async () => {
            const page = await target.newPage();
            return new Proxy(page, { get(target, key) {
              if (key === 'getByRole') return (...args) => args[0] === 'dialog' ? wrapLocator(target.getByRole(...args)) : target.getByRole(...args);
              const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
            } });
          };
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  t.after(async () => { await browser?.close(); });
  await assert.rejects(prove({ origin, timeoutMs: 3000, engine }), error => error.name === 'TimeoutError' || error.exitCode === 78);
  assert.equal(stalled, true);
  assert.equal(browser.isConnected(), false);
});
