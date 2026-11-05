import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

const exec = promisify(execFile);
let outDir;
before(async () => { outDir = temporaryDirectory('offset-proof-cli-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => rm(outDir, { recursive: true, force: true }));

for (const mode of ['success', 'broken', 'protected', 'identity', 'signin', 'chunk-protected', 'timeout']) {
  test(`proof CLI ${mode} with production flags`, async t => {
    const requests = [];
    const server = createServer(async (req, res) => {
      requests.push({ method: req.method, path: req.url });
      if (mode === 'timeout') return;
      if (mode === 'protected') { res.writeHead(403).end(); return; }
      if (mode === 'signin') { res.writeHead(302, { location: '/sign-in' }).end(); return; }
      if (req.url === '/release') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mode === 'identity' ? {} : { source_revision: '1'.repeat(40) })); return;
      }
      if (mode === 'chunk-protected' && req.url !== '/js/ui-calendar-panels.js') { res.writeHead(401).end(); return; }
      try {
        let content = await readFile(join(outDir, 'site', req.url));
        if (mode === 'broken' && req.url === '/js/ui-calendar-panels.js') content = Buffer.from('export async function mountCalendarPanels(left) { return { render() {left.textContent="broken"}, clear() {} }; }');
        res.writeHead(200, { 'content-type': 'text/javascript' }).end(content);
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
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
      assert.equal(receipt.release.source_revision, '1'.repeat(40));
      assert.equal(receipt.assertion_count, 6);
      assert.match(receipt.asset_sha256, /^[0-9a-f]{64}$/);
      assert.ok(receipt.loaded_assets.length > 1, 'real imported chunks loaded');
      assert.ok(receipt.loaded_assets.some(asset => asset.url.endsWith('/home-week.js')));
    }
  });
}
