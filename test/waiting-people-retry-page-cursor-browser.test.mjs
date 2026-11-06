import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { runProof, assertions } from '../scripts/prove-waiting-people-retry-page-cursor.mjs';
let outDir;
before(async () => { outDir = temporaryDirectory('waiting-retry-browser-'); await buildArtifact({ root: process.cwd(), outDir }); await mkdir('/tmp/WR617.S28.J1-evidence', { recursive: true }); });
after(async () => { await rm(outDir, { recursive: true, force: true }); });
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`actual inbox exact page retry ${width} ${theme}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const receipt = await runProof({ origin: server.origin, engine: chromium, viewport: { width, height: 900 }, theme, screenshot: `/tmp/WR617.S28.J1-evidence/retry-${width}-${theme}.png` });
  assert.deepEqual(receipt.assertions, assertions);
  assert.ok(receipt.assets.length <= 30); assert.ok(receipt.bytes <= 10 * 1024 * 1024);
});
