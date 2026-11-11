import { APP_RELEASE_PATH } from '../scripts/app-release-reader.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import { get } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

const exec = promisify(execFile);
let outDir, admitted;
before(async () => { outDir = temporaryDirectory('offset-proof-cli-'); const built = await buildArtifact({ root: process.cwd(), outDir }); admitted = built.manifest.files.map(row => ["/" + row.path, row.path]); });
after(async () => rm(outDir, { recursive: true, force: true }));

for (const mode of ['success', 'broken', 'protected', 'identity', 'signin', 'chunk-protected', 'timeout']) {
  test(`proof CLI ${mode} with production flags`, async t => {
    const siteRoot = resolve(outDir, 'site');
    const assets = await loadFixtureAssets({ root: siteRoot, manifest: new Map(admitted) });
    const release = await handleDoctorcreRequest(new Request('https://fixture.invalid/app-release'), { APP_ENV: 'production', GIT_SHA: mode === 'identity' ? undefined : '1'.repeat(40), CF_VERSION_METADATA: { id: 'synthetic-provider-version' } });
    const responses = new Map(assets);
    responses.set(APP_RELEASE_PATH, { status: release.status, headers: Object.fromEntries(release.headers), body: await release.text(), contentType: 'application/json' });
    for (const [path, response] of responses) {
      if (mode === 'timeout') responses.set(path, { ...response, hold: 'timeout' });
      else if (mode === 'protected') responses.set(path, { status: 403 });
      else if (mode === 'signin') responses.set(path, { status: 302, headers: { location: '/sign-in' } });
      else if (path !== APP_RELEASE_PATH && mode === 'chunk-protected' && path !== '/js/ui-calendar-panels.generated.js') responses.set(path, { status: 401 });
      else if (mode === 'broken' && path === '/js/ui-calendar-panels.generated.js') responses.set(path, { contentType: 'text/javascript', body: 'export async function mountCalendarPanels(left) { return { render() {left.textContent="broken"}, clear() {} }; }' });
    }
    const server = await startFixture({ routes: responses });
    t.after(() => server.close());
    const origin = server.origin;
    if (mode === 'success') {
      const marker = join(outDir, 'outside-marker.txt');
      await writeFile(marker, 'WR616-J3-SYNTHETIC-OUTSIDE-ARTIFACT');
      await writeFile(join(outDir, 'site-outside.txt'), 'WR616-J3-SYNTHETIC-SIBLING-PREFIX');
      const suspiciousFiles = ['%2e%2e-marker.js', '%2E%2E-marker.js', 'back\\slash.js', '%5c-marker.js', 'nul%00.js'];
      for (const file of suspiciousFiles) await writeFile(join(outDir, 'site', 'js', file), 'WR616-J3-SYNTHETIC-SUSPICIOUS-TARGET');
      const escape = '../'.repeat(30) + marker.slice(1);
      for (const path of [
        ...suspiciousFiles.map(file => `/js/${file}`),
        `/${escape}`, '/../outside-marker.txt', '/../site-outside.txt',
        `/${escape.replaceAll('..', '%2e%2e')}`,
        `/${escape.replaceAll('..', '%2E%2E')}`,
        `/${escape.replaceAll('/', '\\')}`, '/js/%5c..%5coutside-marker.txt',
        '/js/ui-calendar-panels.generated.js%00', '/js/%ZZ',
      ]) await t.test(`refuses raw request ${path}`, async () => {
        const response = await new Promise((resolve, reject) => {
          get(`${origin}`, { path }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
          }).on('error', reject);
        });
        assert.equal(response.status, 400, response.body);
        assert.equal(response.body.includes('WR616-J3-SYNTHETIC'), false);
      });
    }
    const flags = ['--origin', origin, '--timeout-ms', mode === 'timeout' ? '100' : '30000'];
    let result;
    try { result = { ...await exec(process.execPath, ['scripts/prove-calendar-panels-offset-order.mjs', ...flags], { timeout: 40000 }), code: 0 }; }
    catch (error) { result = error; }
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(result.code, mode === 'success' ? 0 : ['protected', 'identity', 'signin', 'chunk-protected', 'timeout'].includes(mode) ? 78 : 1, result.stdout + result.stderr);
    assert.equal(receipt.ok, mode === 'success');
    assert.ok(server.requests.every(request => request.method === 'GET'));
    assert.ok(server.requests.length <= 64);
    if (mode === 'success') {
      assert.equal(receipt.origin, origin);
      assert.equal(receipt.release.source_commit, '1'.repeat(40));
      assert.equal(receipt.assertion_count, 6);
      assert.match(receipt.asset_sha256, /^[0-9a-f]{64}$/);
      assert.ok(receipt.loaded_assets.length > 1, 'real imported chunks loaded');
      assert.ok(receipt.loaded_assets.some(asset => asset.url.endsWith('/home-week.js')));
    }
  });
}
