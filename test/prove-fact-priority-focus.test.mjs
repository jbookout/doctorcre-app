import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
import { execFileSync } from 'node:child_process';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
export const browserCases = [];
function test(name, run) { browserCases.push([name, run]); }
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { startFixture } from '../scripts/fixture-http.mjs';
import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
import { assertProofDeadlineCleanup } from './proof-browser-harness.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';
import { prove, requireContainingRelease, signedInEngine } from '../scripts/prove-fact-priority-focus.mjs';
async function fixture(t, mode = 'healthy', revision = '1'.repeat(40)) {
  const assets = await proofAssetSnapshot();
  if (mode === 'protected') for (const key of assets.keys()) assets.set(key,{status:403});
  if (mode === 'broken' || mode === 'stall') assets.set('/js/ui-facts.js',{contentType:'text/javascript',
    body:mode === 'broken' ? 'export function mountFactReview(){throw Error("broken module")}' : 'await new Promise(()=>{});'});
  const release = await handleDoctorcreRequest(new Request('https://app.example/app-release'),{APP_ENV:'production',GIT_SHA:revision});
  const server = await startFixture({assets,routes:new Map([['/app-release',{body:await release.text(),contentType:'application/json'}]])});
  t.after(() => server.close());
  return {origin:server.origin,get seen(){return server.requests.map(row => row.target);}};
}
async function cli(origin, fixture = true, timeoutMs = 30000, { commit = '1'.repeat(40), cwd } = {}) {
  const child = spawn(process.execPath, [new URL('../scripts/prove-fact-priority-focus.mjs', import.meta.url).pathname, '--expected-commit', commit, '--origin', origin, '--timeout-ms', String(timeoutMs), ...(fixture ? ['--fixture'] : [])], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, receipt: JSON.parse(stdout.trim()), stderr };
}
test('fixture CLI passes the recorded module observation', async t => {
  const f = await fixture(t), result = await cli(f.origin);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.receipt.status, 'passed');
  assert.ok(result.receipt.assertions.includes('priority-is-local'));
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
    await assert.rejects(prove({ origin: f.origin, commit: '1'.repeat(40), fixture: true, timeoutMs: 100, engine }), error => error.exitCode === 78);
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
    assert.deepEqual(response, { status: 400, body: '' }, path);
  }
});
for (const mode of ['late launch', 'stalled evaluation']) {
  test(`real Chromium ${mode} leaves zero owned survivors`, async t => {
    const f = await fixture(t);
    await assertProofDeadlineCleanup(t, {
      entry: 'scripts/prove-fact-priority-focus.mjs',
      args: ['--origin', f.origin, '--expected-commit', '1'.repeat(40), '--fixture'],
      mode, timeoutMs: 3000,
    });
  });
}

test('release containment accepts equal and descendant, refuses older unrelated and unknown', async t => {
  const cwd = temporaryDirectory('status-release-');
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  git('commit', '--allow-empty', '-m', 'older'); const older = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'merge'); const merge = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'descendant'); const descendant = git('rev-parse', 'HEAD');
  git('checkout', '--orphan', 'unrelated'); git('commit', '--allow-empty', '-m', 'unrelated'); const unrelated = git('rev-parse', 'HEAD');
  await requireContainingRelease(merge, merge, { cwd });
  await requireContainingRelease(merge, descendant, { cwd });
  for (const observed of [older, unrelated, 'a'.repeat(40)]) await assert.rejects(requireContainingRelease(merge, observed, { cwd }), error => error.exitCode === 78);
});

test('signed-in engine owns its new tab and disconnects without closing existing tabs', async () => {
  let closed = 0, disconnected = 0;
  const existing = { close: () => { throw Error('Existing tab must stay open'); } };
  const engine = { connectOverCDP: async () => ({ contexts: () => [{ pages: () => [existing], newPage: async () => ({ close: async () => { closed++; } }) }], close: async () => { disconnected++; } }) };
  const browser = await signedInEngine('http://127.0.0.1:9222', engine).launch({ timeout: 100 });
  await browser.newPage(); await browser.close();
  assert.equal(closed, 1); assert.equal(disconnected, 1);
  assert.throws(() => signedInEngine('https://remote.example.invalid'));
});

test('unreachable CDP and page acquisition refusal are insufficient evidence', async t => {
  const f = await fixture(t);
  const endpoint = await startFixture(); await endpoint.close();
  const child = spawn(process.execPath, ['scripts/prove-fact-priority-focus.mjs', '--expected-commit', '1'.repeat(40), '--origin', f.origin, '--fixture', '--cdp-url', endpoint.origin], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume();
  assert.equal((await once(child, 'exit'))[0], 78, stdout);
  const engine = { connectOverCDP: async () => ({ contexts: () => [{ newPage: async () => { throw Error('closed'); } }], close: async () => {} }) };
  const borrowed = await signedInEngine('http://127.0.0.1:9222', engine).launch({ timeout: 100 });
  await assert.rejects(borrowed.newPage(), { exitCode: 78 }); await borrowed.close();
});

test('late CDP page is drained before disconnect and preserves existing tabs', async t => {
  const { chromium } = await import('../scripts/proof-browser.mjs');
  const { chromium: driver } = await import('playwright');
  const browserFixture = await ownedCdpFixture(); t.after(() => browserFixture.close());
  const browser = browserFixture.browser;
  t.after(() => browser.close());
  const sentinel = browserFixture.page; await sentinel.setContent('<title>Preserved tab</title>');
  const endpoint = browserFixture.endpoint, before = browser.contexts()[0].pages().length;
  let acquired = false;
  const engine = { connectOverCDP: async (...args) => {
    const connection = await driver.connectOverCDP(...args), context = connection.contexts()[0], newPage = context.newPage.bind(context);
    context.newPage = async () => { const page = await newPage(); acquired = true; await new Promise(resolve => setTimeout(resolve, 1600)); return page; };
    return connection;
  } };
  const f = await fixture(t);
  await assert.rejects(prove({ origin: f.origin, commit: '1'.repeat(40), fixture: true, timeoutMs: 1000, engine: signedInEngine(endpoint, engine) }), { exitCode: 78 });
  assert.equal(acquired, true);
  const observer = await driver.connectOverCDP(endpoint);
  try {
    assert.equal(observer.contexts()[0].pages().length, before);
    assert.equal(await sentinel.title(), 'Preserved tab'); assert.ok(browser.isConnected());
  } finally { await observer.close(); }
});

test('near-miss matching count fails the exact CLI assertion', async t => {
  const assets = await proofAssetSnapshot();
  const asset = assets.get('/js/ui-facts.js');
  const original = Buffer.from(asset.body).toString();
  assert.ok(original.includes(' matching of '));
  asset.body = original.replace(' matching of ', '1 matching of ');
  const release = await handleDoctorcreRequest(new Request('https://app.example/app-release'), { APP_ENV: 'production', GIT_SHA: '1'.repeat(40) });
  const f = await startFixture({ assets, routes: new Map([['/app-release', { body: await release.text(), contentType: 'application/json' }]]) });
  t.after(() => f.close());
  const result = await cli(f.origin);
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.match(result.receipt.error, /exact-count/);
});

test('CLI release gate accepts equal and descendant and refuses older unrelated and unknown', async t => {
  const cwd = temporaryDirectory('priority-cli-release-', t);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  git('commit', '--allow-empty', '-m', 'older'); const older = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'merge'); const merge = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'descendant'); const descendant = git('rev-parse', 'HEAD');
  git('checkout', '--orphan', 'unrelated'); git('commit', '--allow-empty', '-m', 'unrelated'); const unrelated = git('rev-parse', 'HEAD');
  for (const [revision, code] of [[merge, 0], [descendant, 0], [older, 78], [unrelated, 78], ['a'.repeat(40), 78]]) {
    const f = await fixture(t, 'healthy', revision);
    const result = await cli(f.origin, true, 30000, { commit: merge, cwd });
    assert.equal(result.code, code, JSON.stringify(result));
  }
});

test('fixture provenance binds recorded bytes and the current production parser', async () => {
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const base = new URL('./fixtures/fact-priority-focus/', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('provenance.json', base), 'utf8'));
  const digest = async url => createHash('sha256').update(await readFile(url)).digest('hex');
  assert.equal(await digest(new URL('recordings.json', base)), provenance.recordings_sha256);
  assert.equal(await digest(new URL('producer.txt', base)), provenance.producer_file_sha256);
  assert.equal(await digest(new URL('../js/live-client.js', import.meta.url)), provenance.parser_sha256);
  assert.equal(provenance.production_calls, 0);
});
