import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { createServer } from './proof-fixture-server.mjs';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkProofSource, checkProofTransports } from '../scripts/proof-transport-check.mjs';
import { launchProofBrowser, readAppRelease, proofFetch } from '../scripts/app-release-reader.mjs';

const exec = promisify(execFile);
const runners = (await readdir(new URL('../scripts/', import.meta.url))).filter(name => /^prove-.*\.mjs$/.test(name) && name !== 'prove-loop-lint-coverage.mjs');

test('every production proof obeys the transport allowlist', async () => {
  assert.deepEqual(await checkProofTransports(), []);
});

for (const source of [
  "await fetch('https://example.com/app-release')",
  "await globalThis.fetch('https://example.com')",
  "const { fetch: read } = globalThis; await read('https://example.com')",
  "const read = globalThis['fe' + 'tch']; await read('https://example.com')",
  "import * as http from 'node:http'; http.get('http://example.com')",
  "import { get as read } from 'node:https'; read('https://example.com')",
  "await import('node:https')",
  "const assetUrl = 'node:https'; await import(assetUrl)",
  "const { request } = await import('playwright'); await request.newContext()",
  "import { chromium } from 'playwright'; const context = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] }); await context.request.get('https://example.com')",
  "import { execSync } from 'node:child_process'; execSync('/usr/bin/curl https://example.com')",
  "import { execFileSync } from 'node:child_process'; execFileSync('/usr/bin/curl', ['https://example.com'])",
  "import { spawn } from 'node:child_process'; spawn('sh', ['-c', 'curl https://example.com'])",
  "import { execFileSync as read } from 'node:child_process'; read('/usr/bin/curl', ['https://example.com'])",
  "import { execFile } from 'node:child_process'; execFile('/usr/bin/curl', ['https://example.com'], () => {})",
  "import { execFile } from 'node:child_process'; const run = execFile; run('curl', ['https://example.com'])",
  "process.getBuiltinModule('https').get('https://example.com')",
  "import net from 'node:net'",
  "import tls from 'tls'",
  "import { request } from 'undici'",
  "await page.goto('https://example.com/app-release')",
  "await route.fetch({ url: 'https://example.com/app-release' })",
]) test(`transport bypass is refused: ${source}`, () => {
  assert.ok(checkProofSource(source).length, source);
});

test('the reader and declared browser driver remain admissible', () => {
  assert.deepEqual(checkProofSource("import { readAppRelease } from './app-release-reader.mjs'; import { chromium } from 'playwright'; await readAppRelease('https://example.com');"), []);
});

for (const environment of ['staging', undefined]) test(`all proof CLIs refuse ${environment ?? 'missing'} environment through the real reader`, async t => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ service: 'doctorcre-app', environment, source_commit: '1'.repeat(40) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const runner of runners) {
    await t.test(runner, async () => {
      const args = [`scripts/${runner}`, '--origin', origin];
      if (['prove-asset-manifest-publication.mjs', 'prove-territory-evidence-current-history-view.mjs'].includes(runner)) args.push('--commit', '1'.repeat(40));
      args.push('--timeout-ms', '3000');
      await assert.rejects(exec(process.execPath, args, { timeout: 15000 }), error => {
        assert.equal(error.code, 78, `${runner}: ${error.stdout} ${error.stderr}`);
        return true;
      });
    });
  }
});

for (const mode of ['late launch', 'stalled evaluation']) test(`browser deadline cleans up ${mode}`, async () => {
  let alive = 0;
  const engine = { async launch() {
    if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 70));
    alive++;
    return { close: async () => { alive = 0; }, newPage: async () => ({ evaluate: () => new Promise(() => {}) }) };
  } };
  let browser;
  try {
    await assert.rejects(async () => {
      browser = await launchProofBrowser(engine, { timeout: 20 });
      await (await browser.newPage()).evaluate(() => {});
    }, { exitCode: 78 });
  } finally { await browser?.close(); }
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(alive, 0);
});

test('caller signal owns browser lifetime and exact refusal reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = new AbortController();
  const reason = Object.assign(Error('Owner proof deadline exceeded'), { exitCode: 78 });
  let closed = false;
  const engine = { async launch() { return {
    async close() { closed = true; },
    async newPage() { return { evaluate: () => new Promise(() => {}) }; },
  }; } };
  const browser = await launchProofBrowser(engine, { timeout: 1 }, { signal: owner.signal });
  t.mock.timers.tick(100);
  assert.equal(closed, false, 'relative launch budget must not become another lifetime deadline');
  const observing = (await browser.newPage()).evaluate(() => {});
  owner.abort(reason);
  await assert.rejects(observing, error => error === reason);
  assert.equal(closed, true);
  await browser.close();
});

test('already expired proof refuses to launch a browser', async () => {
  const reason = Error('Proof already expired');
  await assert.rejects(launchProofBrowser({ launch() { assert.fail('must not launch'); } }, {}, { signal: AbortSignal.abort(reason) }), error => error === reason);
});

for (const borrowed of [false, true]) test(`real Chromium closes after late acquisition and stalled evaluation (caller deadline ${borrowed})`, async () => {
  const { chromium } = await import('playwright');
  const { CHROMIUM_SAFETY_ARGS } = await import('../scripts/chromium-safety-args.mjs');
  for (const mode of ['late launch', 'stalled evaluation']) {
    let acquired;
    const engine = { async launch(options) {
      acquired = await chromium.launch({ ...options, timeout: 10000, args: [...CHROMIUM_SAFETY_ARGS] });
      if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 1200));
      return acquired;
    } };
    let browser;
    const owner = new AbortController();
    const reason = Object.assign(Error('Owner proof deadline exceeded'), { exitCode: 78 });
    const timer = borrowed ? setTimeout(() => owner.abort(reason), 1000) : undefined;
    try {
      await assert.rejects(async () => {
        browser = await launchProofBrowser(engine, { timeout: 1000 }, borrowed ? { signal: owner.signal } : {});
        const page = await browser.newPage();
        await page.evaluate(() => new Promise(() => {}));
      }, { exitCode: 78 });
    } finally { clearTimeout(timer); await browser?.close(); }
    const until = Date.now() + 12000;
    while ((!acquired || acquired.isConnected()) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(acquired, mode);
    assert.equal(acquired.isConnected(), false, mode);
  }
});

test('pure modules and ordinary globals are outside transport enforcement', () => {
  assert.deepEqual(checkProofSource("import { detail } from '../test/leads-workspace-fixture.mjs'; import { basename } from 'node:path'; const decoder = new TextDecoder(); process.exitCode = 0;"), []);
});

for (const indirect of [false, true]) test(`local helper transport is refused, transitive=${indirect}`, async t => {
  const root = temporaryDirectory('proof-import-', t);
  await mkdir(root + '/scripts');
  await writeFile(root + '/scripts/prove-regression.mjs', "import {read} from './helper.mjs'; await read('http://example.com/app-release');");
  await writeFile(root + '/scripts/helper.mjs', indirect ? "export { read } from './network-helper.mjs';" : "export async function read(url) { return (await fetch(url)).json(); }");
  if (indirect) await writeFile(root + '/scripts/network-helper.mjs', "export async function read(url) { return (await fetch(url)).json(); }");
  const errors = await checkProofTransports(pathToFileURL(root + '/'));
  assert.ok(errors.some(error => error.includes('fetch')), errors.join('\n'));
  await writeFile(root + '/scripts/helper.mjs', 'export const read = () => 1;');
  assert.deepEqual(await checkProofTransports(pathToFileURL(root + '/')), []);
});

test('fixture refuses helper fetch and variable browser release navigation but admits the reader', async t => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = temporaryDirectory('proof-helper-', t);
  await writeFile(root + '/network-helper.mjs', 'export async function read(url) { return (await fetch(url)).json(); }');
  const { read } = await import(pathToFileURL(root + '/network-helper.mjs'));
  await assert.rejects(read(origin + '/app-release'));
  assert.equal((await fetch(origin + '/app-release')).status, 403);
  assert.equal((await fetch(origin + '/app-release?probe=1')).status, 403);
  assert.equal((await fetch(origin + '/asset.js')).status, 200);
  const { chromium } = await import('playwright');
  const { CHROMIUM_SAFETY_ARGS } = await import('../scripts/chromium-safety-args.mjs');
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    const page = await browser.newPage();
    const releaseUrl = new URL('/app-release', origin).href;
    const response = await page.goto(releaseUrl);
    assert.equal(response.status(), 403);
    await assert.rejects(async () => JSON.parse(await page.locator('body').innerText()));
  } finally { await browser.close(); }
  assert.equal((await readAppRelease(origin)).environment, 'production');
});

test('reader marks requests and preserves caller User-Agent and headers', async t => {
  let seen;
  const server = createServer((req, res) => {
    seen = req.headers;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const headers = new Headers({ 'user-agent': 'existing-proof-agent/1', 'x-fixture': 'retained' });
  await proofFetch(`http://127.0.0.1:${server.address().port}/app-release`, { headers });
  assert.equal(seen['x-doctorcre-release-reader'], '1');
  assert.equal(seen['user-agent'], 'existing-proof-agent/1');
  assert.equal(seen['x-fixture'], 'retained');
  assert.equal(headers.has('x-doctorcre-release-reader'), false);
});

test('asynchronous read-only git ancestry remains admissible', () => {
  assert.deepEqual(checkProofSource("import { execFile } from 'node:child_process'; execFile('git', ['merge-base', '--is-ancestor', required, released], { signal }, error => {});"), []);
});
