import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { uiAssets } from '../scripts/ui-bundle.mjs';

const assets = await uiAssets(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, mode) {
  const fixtureAssets = new Map(assets);
  if (mode === 'assertion') fixtureAssets.set('js/ui-action.generated.js', Buffer.from('export function mountActionLink(){throw Error("Synthetic contradiction")}'));
  if (mode === 'foreign') fixtureAssets.set('js/ui-action.generated.js', Buffer.from('import "https://foreign.invalid/code.js";'));
  const manifest = { schema: 'doctorcre-static-artifact.v1', repository: 'jbookout/doctorcre-app', source_commit: '1'.repeat(40),
    files: [...fixtureAssets].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) };
  if (mode === 'canonical') manifest.repository = 'DoctorCRE/doctorcre-app';
  if (mode === 'unrelated') manifest.repository = 'DoctorCRE/other';
  if (mode === 'mismatch') manifest.source_commit = '2'.repeat(40);
  const responses = new Map([...fixtureAssets].map(([path, bytes]) => ['/' + path,
    mode === 'unavailable' ? { status: 404 } : { body: mode === 'wrong-asset' ? 'export const wrong = true;' : bytes, contentType: 'text/javascript' }]));
  responses.set('/app-release', { body: JSON.stringify(mode === 'release' ? {} : { service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }), contentType: 'application/json' });
  responses.set('/artifact-manifest.json', { body: mode === 'manifest' ? '{' : JSON.stringify(manifest), contentType: 'application/json' });
  if (mode === 'timeout') for (const [path, response] of responses) responses.set(path, { ...response, hold: 'timeout' });
  const server = await startFixture({ routes: responses });
  t.after(() => server.close());
  return { origin: server.origin, get seen() { return server.requests.map(req => [req.method, req.path]); } };
}
async function cli(origin, timeout = '30000') {
  const child = spawn(process.execPath, ['scripts/prove-action-link-schedule-strict-instant.mjs', '--origin', origin, '--timeout-ms', timeout], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code, receipt: JSON.parse(stdout.trim()), stderr };
}
test('CLI executes manifest-bound deployed graph using exact production flags', async t => {
  const f = await fixture(t);
  const { code, receipt } = await cli(f.origin);
  assert.equal(code, 0, JSON.stringify(receipt));
  assert.ok(receipt.assertions.length > 50);
  assert.ok(receipt.assets.length > 1);
  assert.ok(receipt.assets.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.ok(receipt.requests <= 10);
  assert.ok(f.seen.every(([method, path]) => method === 'GET' && (['/app-release', '/artifact-manifest.json'].includes(path) || assets.has(path.slice(1)))));
});
for (const [mode, expected] of [['manifest', 78], ['release', 78], ['unavailable', 78], ['wrong-asset', 1], ['mismatch', 1], ['foreign', 1], ['assertion', 1], ['timeout', 78]]) {
  test(`CLI refuses ${mode}`, async t => {
    const f = await fixture(t, mode);
    const { code, receipt } = await cli(f.origin, mode === 'timeout' ? '100' : '30000');
    assert.equal(code, expected, JSON.stringify(receipt));
    assert.notEqual(receipt.status, 'passed');
    assert.ok(f.seen.length <= 10);
  });
}

for (const [mode, expected] of [['canonical', 0], ['unrelated', 78]]) test(`manifest repository ${mode}`, async t => {
  const f = await fixture(t, mode), result = await cli(f.origin);
  assert.equal(result.code, expected, JSON.stringify(result));
});
