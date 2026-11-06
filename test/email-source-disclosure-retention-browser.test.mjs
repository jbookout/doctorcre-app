import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { observe } from '../scripts/prove-email-source-disclosure-retention.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

test('source disclosure lifecycle at phone and desktop widths in both themes', async t => {
  const outDir = temporaryDirectory('source-disclosure-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: process.cwd(), outDir });
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) await t.test(`${width} ${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
    try {
      await page.goto(server.origin + '/review-workflows?mode=fixture');
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const receipt = await observe(page);
      assert.equal(receipt.checks.length, 21);
      assert.equal(receipt.fixture_contract, 'email-proposals.v1');
    } finally { await page.close(); }
  });
});
