import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('hard-cap proof CLI executes served bytes and refuses failures and protected assets', async t => {
  const artifact = await temporaryDirectory('documents-proof-', t);
  const built = await buildArtifact({ root, outDir: artifact, commit: '1'.repeat(40) });
  await writeFile(`${artifact}/sentinel.js`, 'review-owned-sentinel');
  const fixtureRoot = resolve(artifact, 'site');
  const admitted = new Map(built.manifest.files.filter(row => row.path.startsWith('js/')).map(row => ['/' + row.path, row.path]));
  const snapshot = await loadFixtureAssets({ root: fixtureRoot, manifest: admitted });
  const requests = [];
  async function fixture(mode) {
    const responses = new Map(snapshot);
    for (const path of ['/release', '/app-release']) responses.set(path, { contentType: 'application/json', body: JSON.stringify(mode === 'identity' ? {} : { service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }) });
    for (const [path, response] of responses) {
      if (mode === 'timeout') responses.set(path, { ...response, hold: 'timeout' });
      else if (mode === 'protected') responses.set(path, { status: 403 });
      else if (path === '/release' && mode === 'fallback') responses.set(path, { status: 404 });
      else if (path.startsWith('/js/') && mode === 'broken' && path === '/js/ui-deal-documents.generated.js') responses.set(path, { contentType: 'text/javascript', body: 'export function mountDealDocuments(){throw Error("Synthetic broken deployment")}' });
      else if (path.startsWith('/js/') && mode === 'asset-protected' && path !== '/js/ui-deal-documents.generated.js') responses.set(path, { status: 302, headers: { location: '/sign-in' } });
    }
    return startFixture({ routes: responses });
  }
  const server = await fixture('success');
  t.after(() => server.close());
  const origin = server.origin;
  for (const path of [
    '/js/../../sentinel.js',
    '/js/../js/ui-deal-documents.generated.js',
    '/js/%2e%2e/%2e%2e/sentinel.js',
    '/js/%2E%2E/sentinel.js',
    '/js/..%2f..%2fsentinel.js',
    '/js/..\\..\\sentinel.js',
    '/js/%5c..%5csentinel.js',
    '/js/ui-deal-documents.generated.js%00',
  ]) {
    await t.test(`refuses raw asset path ${path}`, async () => {
      const response = await new Promise((resolve, reject) => {
        const req = request(`${origin}/`, { path, timeout: 5000 }, res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(Error('Fixture request timed out')));
        req.end();
      });
      assert.equal(response.status, 400, response.body);
      assert.equal(response.body, '');
    });
  }
  for (const [scenario, expected] of [['success', 0], ['fallback', 0], ['broken', 1], ['protected', 78], ['identity', 78], ['asset-protected', 78], ['timeout', 1]]) {
    await t.test(scenario, async () => {
      const scenarioServer = await fixture(scenario);
      t.after(() => scenarioServer.close());
      const origin = scenarioServer.origin;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/prove-deal-documents-hard-cap.mjs', '--origin', origin, '--timeout-ms', scenario === 'timeout' ? '200' : '30000'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 40000 });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
        child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
      });
      requests.push(...scenarioServer.requests);
      await scenarioServer.close();
      assert.equal(result.code, expected, result.stderr);
      if (expected === 0) {
        const receipt = JSON.parse(result.stdout);
        assert.equal(receipt.origin, origin);
        assert.equal(receipt.release.source_commit, '1'.repeat(40));
        assert.deepEqual(receipt.observed, { rows: 500, requests: 11 });
        assert.equal(receipt.assertions.passed, 4);
        assert.ok(receipt.assets.length > 1, 'real imported chunks execute');
        for (const asset of receipt.assets) assert.match(asset.sha256, /^[0-9a-f]{64}$/);
      }
    });
  }
  assert.ok(requests.every(request => request.method === 'GET'));
});
