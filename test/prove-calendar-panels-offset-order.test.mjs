import { handleDoctorcreRequest } from '../src/worker.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

const exec = promisify(execFile);
let outDir;
before(async () => { outDir = temporaryDirectory('offset-proof-cli-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => rm(outDir, { recursive: true, force: true }));

for (const mode of ['success', 'broken', 'protected', 'identity', 'signin', 'chunk-protected', 'timeout']) {
  test(`proof CLI ${mode} with production flags`, async t => {
    const requests = [];
    const siteRoot = resolve(outDir, 'site');
    const server = createServer(async (req, res) => {
      requests.push({ method: req.method, path: req.url });
      if (mode === 'timeout') return;
      if (mode === 'protected') { res.writeHead(403).end(); return; }
      if (mode === 'signin') { res.writeHead(302, { location: '/sign-in' }).end(); return; }
      if (req.url === '/app-release') {
        const response = await handleDoctorcreRequest(new Request('https://fixture.invalid/app-release'), { APP_ENV: 'production', GIT_SHA: mode === 'identity' ? undefined : '1'.repeat(40), CF_VERSION_METADATA: { id: 'synthetic-provider-version' } });
        res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text()); return;
      }
      if (mode === 'chunk-protected' && req.url !== '/js/ui-calendar-panels.js') { res.writeHead(401).end(); return; }
      try {
        const requestedPath = decodeURIComponent(req.url);
        if (/%2e|%5c|%00/i.test(req.url) || requestedPath.includes('\\') || requestedPath.includes(String.fromCharCode(0))) {
          res.writeHead(404).end(); return;
        }
        const file = resolve(siteRoot, requestedPath.slice(1));
        if (!file.startsWith(siteRoot + sep)) { res.writeHead(404).end(); return; }
        let content = await readFile(file);
        if (mode === 'broken' && req.url === '/js/ui-calendar-panels.js') content = Buffer.from('export async function mountCalendarPanels(left) { return { render() {left.textContent="broken"}, clear() {} }; }');
        res.writeHead(200, { 'content-type': 'text/javascript' }).end(content);
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
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
        '/js/ui-calendar-panels.js%00', '/js/%ZZ',
      ]) await t.test(`refuses raw request ${path}`, async () => {
        const response = await new Promise((resolve, reject) => {
          get(`${origin}`, { path }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
          }).on('error', reject);
        });
        assert.equal(response.status, 404, response.body);
        assert.equal(response.body.includes('WR616-J3-SYNTHETIC'), false);
      });
    }
    const flags = ['--origin', origin, '--timeout-ms', mode === 'timeout' ? '100' : '30000'];
    let result;
    try { result = { ...await exec(process.execPath, ['scripts/prove-calendar-panels-offset-order.mjs', ...flags], { timeout: 40000 }), code: 0 }; }
    catch (error) { result = error; }
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(result.code, mode === 'success' ? 0 : ['protected', 'identity', 'signin', 'chunk-protected'].includes(mode) ? 78 : 1, result.stdout + result.stderr);
    assert.equal(receipt.ok, mode === 'success');
    assert.ok(requests.every(request => request.method === 'GET'));
    assert.ok(requests.length <= 64);
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
