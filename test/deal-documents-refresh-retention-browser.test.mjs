import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { chromium } from './browser-harness.mjs';
import { observeRefreshRetention } from '../scripts/prove-deal-documents-refresh-retention.mjs';

test('refresh retains last successful metadata and replaces scans', async t => {
  const artifact = await temporaryDirectory('documents-retention-', t);
  await buildArtifact({ root: process.cwd(), outDir: artifact, commit: '1'.repeat(40) });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${artifact}/site` } }); t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    for (const failure of ['network', '503', 'malformed', '401', '403']) {
      for (const replacement of (['401', '403'].includes(failure) ? ['nonempty'] : ['nonempty', 'empty', 'dispose', 'invalidate'])) {
        await t.test(`${failure} ${replacement} ${width} ${theme}`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
          try {
            await page.route('**/documents-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
            await page.goto(`${server.url}/documents-harness`);
            const result = await page.evaluate(observeRefreshRetention, { assetUrl: '/js/ui-deal-documents.js', failure, replacement });
            assert.ok(result.retained || result.authorizationCleared);
          } finally { await page.close(); }
        });
      }
    }
  }
});
