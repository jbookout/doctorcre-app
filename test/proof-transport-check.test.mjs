import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { startFixture } from '../scripts/fixture-http.mjs';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkProofSource, checkProofTransports, proofRunners } from '../scripts/proof-transport-check.mjs';
import { launchProofBrowser, readAppRelease, proofFetch } from '../scripts/app-release-reader.mjs';

const exec = promisify(execFile);
const runners = (await proofRunners()).filter(name => name !== 'prove-loop-lint-coverage.mjs');

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
  const server = await startFixture({ routes: new Map([['/app-release', { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment, source_commit: '1'.repeat(40) }) }]]) });
  t.after(() => server.close());
  const origin = server.origin;
  for (const runner of runners) {
    await t.test(runner, async () => {
      const args = [`scripts/${runner}`, '--origin', origin];
      if (['prove-email-deal-picker-auth-retirement.ts', 'prove-brief-queue-menu-malformed-section.ts', 'prove-reply-draft-recipient-race.ts', 'prove-call-review-decision-replay-key.ts', 'prove-asset-manifest-publication.mjs', 'prove-fact-review-pending-status-view.mjs', 'prove-territory-evidence-current-history-view.mjs', 'prove-reply-action-link.ts', 'prove-exact-action-cards.ts'].includes(runner)) args.push('--commit', '1'.repeat(40));
      if (runner === 'prove-introduction-review.ts') args.push('--expected-commit', '1'.repeat(40));
      if (runner === 'prove-queued-asks-corrupt-entry-isolation.ts') args.push('--revision', '1'.repeat(40));
      if (runner === 'prove-reply-action-link.ts') args.push('--ref', 'synthetic', '--proposal-id', 'synthetic', '--foreign-ref', 'synthetic-foreign');
      if (runner === 'prove-exact-action-cards.ts') args.push('--reply-ref','synthetic','--reply-id','synthetic','--call-ref','synthetic','--call-id','synthetic','--feedback-ref','synthetic','--feedback-id','synthetic','--foreign-ref','foreign');
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
  const server = await startFixture({ routes: new Map([
    ['/app-release', { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }) }],
    ['/asset.js', { contentType: 'text/javascript', body: 'export {};' }],
  ]) });
  t.after(() => server.close());
  const origin = server.origin;
  const { read } = await import('./fixtures/unmarked-network-helper.mjs');
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
  const server = await startFixture({ routes: new Map([['/app-release', { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }) }]]) });
  t.after(() => server.close());
  const headers = new Headers({ 'user-agent': 'existing-proof-agent/1', 'x-fixture': 'retained' });
  await proofFetch(server.origin + '/app-release', { headers });
  const seen = server.requests[0].headers;
  assert.equal(seen['x-doctorcre-release-reader'], '1');
  assert.equal(seen['user-agent'], 'existing-proof-agent/1');
  assert.equal(seen['x-fixture'], 'retained');
  assert.equal(headers.has('x-doctorcre-release-reader'), false);
});

test('a local helper named proof-browser cannot bypass transport policy', async t => {
  const root = temporaryDirectory('proof-fake-browser-', t);
  await mkdir(root + '/scripts');
  await writeFile(root + '/scripts/prove-fake.mjs', "import { read } from './proof-browser.mjs'; await read();");
  await writeFile(root + '/scripts/proof-browser.mjs', "export const read = () => fetch('https://example.com');");
  const errors = await checkProofTransports(pathToFileURL(root + '/'));
  assert.ok(errors.some(error => error.includes('fetch')), errors.join('\n'));
});

test('asynchronous read-only git ancestry remains admissible', () => {
  assert.deepEqual(checkProofSource("import { execFile } from 'node:child_process'; execFile('git', ['merge-base', '--is-ancestor', required, released], { signal }, error => {});"), []);
});

for (const helper of [false, true]) test(`TypeScript proof transport is refused, helper=${helper}`, async t => {
  const root = temporaryDirectory('proof-typescript-', t);
  await mkdir(root + '/scripts');
  await writeFile(root + '/scripts/prove-regression.ts', helper
    ? "import { read } from './helper.ts'; await read();"
    : "await fetch('/synthetic');");
  if (helper) await writeFile(root + '/scripts/helper.ts', "export const read = () => fetch('/synthetic');");
  const errors = await checkProofTransports(pathToFileURL(root + '/'));
  assert.ok(errors.some(error => error.includes('fetch')), errors.join('\n'));
});

test('TypeScript type imports declare no runtime capability', () => {
  assert.deepEqual(checkProofSource("import type { Page } from 'playwright'; import { type Locator, chromium } from 'playwright';", 'prove-types.ts'), []);
  assert.ok(checkProofSource("import { Page } from 'playwright';", 'prove-types.ts').length);
});

for (const declaration of [
  "import type { Options } from './helper.ts';",
  "export type { Options } from './helper.ts';",
]) test(`erased TypeScript edge is not traversed: ${declaration}`, async t => {
  const root = temporaryDirectory('proof-type-edge-', t);
  await mkdir(root + '/scripts');
  await writeFile(root + '/scripts/prove-types.ts', declaration);
  await writeFile(root + '/scripts/helper.ts', "export type Options = { label: string }; export type Other = string; export const unusedRead = () => fetch('/synthetic');");
  assert.deepEqual(await checkProofTransports(pathToFileURL(root + '/')), []);
});

test('mixed TypeScript import retains its runtime helper edge', async t => {
  const root = temporaryDirectory('proof-mixed-edge-', t);
  await mkdir(root + '/scripts');
  await writeFile(root + '/scripts/prove-types.ts', "import { type Options, read } from './helper.ts';");
  await writeFile(root + '/scripts/helper.ts', "export type Options = { label: string }; export const read = () => fetch('/synthetic');");
  const errors = await checkProofTransports(pathToFileURL(root + '/'));
  assert.ok(errors.some(error => error.includes('helper.ts:1:') && error.includes('(fetch)')), errors.join('\n'));
});

for (const declaration of [
  "import { type Options, type Other } from './helper.ts';",
  "import {\n type Options,\n type Other\n} from './helper.ts';",
]) test(`inline type import executes its helper: ${declaration}`, async t => {
  const root = temporaryDirectory('proof-inline-types-', t);
  await mkdir(root + '/scripts');
  await writeFile(root + '/scripts/prove-types.ts', declaration);
  await writeFile(root + '/scripts/helper.ts', "export type Options = string; export type Other = string; await fetch('/synthetic');");
  const errors = await checkProofTransports(pathToFileURL(root + '/'));
  assert.ok(errors.some(error => error.includes('helper.ts:1:') && error.includes('(fetch)')), errors.join('\n'));
});

test('Node erasure removes commented type imports and transport names in type declarations', () => {
  assert.deepEqual(checkProofSource("import /* erased */ type { Page } from 'playwright'; export /* erased */ type { Page } from 'playwright'; type Transport = { fetch: () => void };", 'prove-types.ts'), []);
});

for (const syntax of ['enum Mode { Read }', 'namespace Mode { export const read = 1; }']) test(`unsupported Node strip syntax is refused: ${syntax}`, async t => {
  assert.match(checkProofSource(syntax, 'prove-types.ts').join('\n'), /Node TypeScript stripping refused/);
  const root = temporaryDirectory('proof-unsupported-types-', t);
  await mkdir(root + '/scripts');
  await writeFile(root + '/scripts/prove-types.ts', "import './helper.ts';");
  await writeFile(root + '/scripts/helper.ts', syntax);
  const errors = await checkProofTransports(pathToFileURL(root + '/'));
  assert.match(errors.join('\n'), /helper.ts: Node TypeScript stripping refused/);
});

test('proof schema imports are data and invalid JSON is refused',async t=>{
 const root=temporaryDirectory('proof-schema-',t);await mkdir(root+'/scripts');
 await writeFile(root+'/scripts/prove-schema.ts',"import schema from './schema.json' with {type:'json'};");
 await writeFile(root+'/scripts/schema.json',JSON.stringify({type:'object'}));
 assert.deepEqual(await checkProofTransports(pathToFileURL(root+'/')),[]);
 await writeFile(root+'/scripts/schema.json','not JSON');
 assert.match((await checkProofTransports(pathToFileURL(root+'/'))).join('\n'),/invalid JSON import/);
});
