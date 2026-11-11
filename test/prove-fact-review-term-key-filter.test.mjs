import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { startFixture } from '../scripts/fixture-http.mjs';
import { prove } from '../scripts/prove-fact-review-term-key-filter.mjs';
const artifact = temporaryDirectory('term-filter-snapshot-');
after(() => rm(artifact, { recursive: true, force: true }));
const built = await buildArtifact({ root: process.cwd(), outDir: artifact });
const snapshot = await loadFixtureAssets({ root: `${artifact}/site`, manifest: new Map(built.manifest.files.filter(row => row.path.startsWith('js/')).map(row => ['/' + row.path, row.path])) });
async function fixture(t, mode = 'healthy') {
  const responses = new Map(snapshot);
  responses.set('/app-release', { body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }), contentType: 'application/json' });
  if (mode === 'protected') for (const path of snapshot.keys()) responses.set(path, { status: 403 });
  if (mode === 'broken' || mode === 'stall') responses.set('/js/ui-facts.generated.js', { contentType: 'text/javascript',
    body: mode === 'broken' ? 'export function mountFactReview(){throw Error("broken module")}' : 'await new Promise(()=>{});' });
  const server = await startFixture({ routes: responses });
  t.after(() => server.close());
  return { origin: server.origin, get seen() { return server.requests.map(req => req.target); } };
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
    assert.deepEqual(response, { status: 400, body: '' }, path);
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
