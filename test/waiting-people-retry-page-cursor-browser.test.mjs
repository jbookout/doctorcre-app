import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { createServer } from 'node:http';
import { handleDoctorcreRequest } from '../src/worker.js';
import { runProof, assertions } from '../scripts/prove-waiting-people-retry-page-cursor.mjs';
let outDir;
before(async () => { outDir = temporaryDirectory('waiting-retry-browser-'); await buildArtifact({ root: process.cwd(), outDir }); await mkdir('/tmp/WR617.S28.J1-evidence', { recursive: true }); });
after(async () => { await rm(outDir, { recursive: true, force: true }); });
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`actual inbox exact page retry ${width} ${theme}`, async t => {
  const assets = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => assets.close());
  const server = createServer(async (req, res) => {
    const response = await handleDoctorcreRequest(new Request(assets.origin + req.url), {
      GIT_SHA: '1'.repeat(40), APP_ENV: 'production',
      ASSETS: { fetch: request => fetch(request) },
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const receipt = await runProof({ origin, engine: chromium, viewport: { width, height: 900 }, theme, screenshot: `/tmp/WR617.S28.J1-evidence/retry-${width}-${theme}.png` });
  assert.deepEqual(receipt.assertions, assertions);
  assert.ok(receipt.assets.length <= 30); assert.ok(receipt.bytes <= 10 * 1024 * 1024);
});
