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
  const child = spawn(process.execPath, ['scripts/prove-fact-excerpt-invalid-expiry.mjs', '--origin', origin, '--timeout-ms', timeout], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  assert.equal(receipt.assertions, 28);
  assert.equal(receipt.synthetic_write_calls, 0);
  assert.equal(receipt.release.source_commit, '1'.repeat(40));
  assert.ok(receipt.assets.length > 1, 'real shared chunks loaded');
  assert.ok(receipt.assets.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.ok(f.seen.every(req => req.method === 'GET'));
  assert.ok(f.seen.every(req => ['/release', '/app-release'].includes(req.path) || req.path.startsWith('/js/')));
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
