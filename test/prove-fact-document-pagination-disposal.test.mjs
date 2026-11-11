import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { uiAssets } from '../scripts/ui-bundle.mjs';

const assets = await uiAssets(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));

async function fixture(t, mode) {
  const responses = new Map([...assets].map(([path, body]) => ['/' + path,
    mode === 'protected' ? { status: 302, headers: { location: '/sign-in' } } : { body, contentType: 'text/javascript' }]));
  responses.set('/app-release', { body: JSON.stringify(mode === 'identity' ? {} : { service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }), contentType: 'application/json' });
  if (['broken', 'write', 'network'].includes(mode)) responses.set('/js/ui-facts.generated.js', { contentType: 'text/javascript',
    body: mode === 'broken' ? 'export function mountFactReview(){throw Error("fixture broken")}' : mode === 'write' ? 'export function mountFactReview(root, {client}){client.recordHumanFact();return {refresh:async()=>{},dispose(){}}}' : 'await fetch("/api/business", {method:"POST"}); export function mountFactReview(){}' });
  if (mode === 'timeout') for (const [path, response] of responses) responses.set(path, { ...response, hold: 'timeout' });
  const server = await startFixture({ routes: responses });
  t.after(() => server.close());
  return { origin: server.origin, get seen() { return server.requests; } };
}

async function cli(origin, timeout = '30000') {
  const child = spawn(process.execPath, ['scripts/prove-fact-document-pagination-disposal.mjs', '--origin', origin, '--timeout-ms', timeout], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, receipt: JSON.parse(stdout.trim()), stderr };
}

test('CLI observes real entry and imported chunks with production flags', async t => {
  const f = await fixture(t);
  const { code, receipt } = await cli(f.origin);
  assert.equal(code, 0, JSON.stringify(receipt));
  assert.equal(receipt.status, 'passed');
  assert.ok(receipt.assertions.includes('disposed-first'));
  assert.ok(receipt.assertions.includes('expired-later'));
  assert.ok(receipt.assertions.includes('healthy-fact-review-usable'));
  assert.equal(receipt.synthetic_write_calls, 0);
  assert.equal(receipt.release.source_commit, '1'.repeat(40));
  assert.ok(receipt.assets.length > 1, 'real shared chunks loaded');
  assert.ok(receipt.assets.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.ok(f.seen.every(req => req.method === 'GET'));
  assert.ok(f.seen.every(req => ['/app-release'].includes(req.path) || req.path.startsWith('/js/')));
});

for (const [mode, expected] of [['broken', 1], ['write', 1], ['network', 1], ['protected', 78], ['identity', 78], ['timeout', 78]]) {
  test(`CLI refuses ${mode} without a passing receipt`, async t => {
    const f = await fixture(t, mode);
    const { code, receipt } = await cli(f.origin, mode === 'timeout' ? '500' : '30000');
    assert.equal(code, expected, JSON.stringify(receipt));
    assert.notEqual(receipt.status, 'passed');
    assert.ok(!f.seen.some(req => req.path.startsWith('/api/')));
    assert.ok(!f.seen.some(req => req.path === '/sign-in'));
  });
}

test('proof declaration binds the exact CLI and registered response contract', async () => {
  const plan = JSON.parse(await readFile(new URL('../proofs/requirements/fact-document-pagination-disposal.json', import.meta.url)));
  assert.ok(plan.assertions[0].predicate.includes('node scripts/prove-fact-document-pagination-disposal.mjs --origin https://app.doctorcre.com --timeout-ms 30000'));
  assert.equal(plan.assertions[0].runner, 'app-release-live-walk.v1');
  assert.equal(plan.safety.max_requests, 32);
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/fact_review.json', import.meta.url)));
  assert.equal(contract.documents.verb, 'list-deal-documents');
  assert.equal(contract.documents.schema_version, 'deal-documents.v1');
  const { observePagination } = await import('../scripts/prove-fact-document-pagination-disposal.mjs');
  for (const field of contract.documents.fields) assert.ok(observePagination.toString().includes(field), `fixture missing registered field ${field}`);
});
