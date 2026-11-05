import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('hard-cap proof CLI executes served bytes and refuses failures and protected assets', async t => {
  const artifact = await temporaryDirectory('documents-proof-', t);
  await buildArtifact({ root, outDir: artifact, commit: '1'.repeat(40) });
  await writeFile(`${artifact}/sentinel.js`, 'review-owned-sentinel');
  const fixtureRoot = resolve(artifact, 'site');
  let mode = 'success';
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (mode === 'timeout') return;
    if (mode === 'protected') { res.writeHead(403); return res.end(); }
    if (req.url === '/release') {
      if (mode === 'fallback') { res.writeHead(404); return res.end(); }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(mode === 'identity' ? {} : { service: 'doctorcre-app', source_commit: '1'.repeat(40) }));
    }
    if (req.url === '/app-release') return res.end(JSON.stringify(mode === 'fallback' ? { service: 'doctorcre-app', source_commit: '1'.repeat(40) } : {}));
    try {
      if (!/^\/js\/[\w/.-]+\.js$/.test(req.url) || /[%\\\0]/.test(req.url) || /(?:^|\/)\.\.?(?:\/|$)/.test(req.url)) throw Error('bad path');
      const assetPath = resolve(fixtureRoot, `.${req.url}`);
      if (!assetPath.startsWith(fixtureRoot + sep)) throw Error('bad path');
      let bytes = await readFile(assetPath);
      if (mode === 'broken' && req.url === '/js/ui-deal-documents.js') bytes = Buffer.from('export function mountDealDocuments(){throw Error("Synthetic broken deployment")}');
      if (mode === 'asset-protected' && req.url !== '/js/ui-deal-documents.js') { res.writeHead(302, { location: '/sign-in' }); return res.end(); }
      res.setHeader('Content-Type', 'text/javascript'); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of [
    '/js/../../sentinel.js',
    '/js/../js/ui-deal-documents.js',
    '/js/%2e%2e/%2e%2e/sentinel.js',
    '/js/%2E%2E/sentinel.js',
    '/js/..%2f..%2fsentinel.js',
    '/js/..\\..\\sentinel.js',
    '/js/%5c..%5csentinel.js',
    '/js/ui-deal-documents.js%00',
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
      assert.equal(response.status, 404, response.body);
      assert.equal(response.body, '');
    });
  }
  for (const [scenario, expected] of [['success', 0], ['fallback', 0], ['broken', 1], ['protected', 78], ['identity', 78], ['asset-protected', 78], ['timeout', 1]]) {
    await t.test(scenario, async () => {
      mode = scenario;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/prove-deal-documents-hard-cap.mjs', '--origin', origin, '--timeout-ms', scenario === 'timeout' ? '200' : '30000'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 40000 });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
        child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
      });
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
