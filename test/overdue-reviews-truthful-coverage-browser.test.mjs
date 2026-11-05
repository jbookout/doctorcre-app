import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { assertCoverage } from '../scripts/prove-overdue-reviews-truthful-coverage.mjs';

test('public mount coverage at phone and desktop widths', async t => {
  const outDir = temporaryDirectory('coverage-browser-', t);
  await buildArtifact({ root: process.cwd(), outDir });
  const { server } = await createQaServer({ buildRoot: join(outDir, 'site') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto('http://127.0.0.1:' + server.address().port);
    const assertions = await page.evaluate(assertCoverage);
    assert.ok(assertions.length > 10); assert.ok(assertions.every(a => a.passed));
    await page.close();
  }
});
