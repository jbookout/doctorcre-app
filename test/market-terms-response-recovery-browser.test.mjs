import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

test('malformed comparison retains workspace and recovers on explicit retry in both themes and widths', async () => {
  const server = await fixtureServer();
  const browser = await chromium.launch();
  try {
    for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.origin}/deals?deal=d14`);
      await page.locator('#detailUpdateForm').waitFor({ state: 'visible' });
      await page.evaluate(async theme => {
        document.documentElement.dataset.theme = theme;
        const { mountMarketTerms } = await import('/js/ui-market.generated.js');
        const root = document.createElement('section'); root.id = 'recovery-proof';
        document.querySelector('#recordPanel').append(root);
        let reads = 0;
        window.recoveryPanel = mountMarketTerms(root, {entityRef:'d14',submarket:'North',client:{readMarketTerms:async () => ({ok:true,schema_version:'market-terms.v1',rows:++reads === 1 ? [null] : [],coverage:{recorded_documents:1,canonical_receipts:1,unsupported_receipts:0,unclassified_receipts:0,comparable_deals:0}})}});
      }, theme);
      const root = page.locator('#recovery-proof');
      await root.getByText('Could not load comparable terms. Try again.').waitFor();
      await root.locator('[name=submarket]').fill('South');
      await root.locator('[name=as_of]').fill('2025-01-01');
      await mkdir('out/test-artifacts/market-terms-recovery', { recursive: true });
      await root.screenshot({path:`out/test-artifacts/market-terms-recovery/${width}-${theme}-unavailable.png`});
      await root.getByRole('button', { name: 'Compare', exact: true }).click();
      await root.getByText('No comparable terms match these filters.').waitFor();
      assert.equal(await root.locator('[name=submarket]').inputValue(), 'South');
      assert.match(await root.textContent(), /Terms as of 2025-01-01/);
      assert.equal(await page.locator('#detailUpdateForm').isVisible(), true);
      assert.deepEqual(errors, []);
      await root.screenshot({path:`out/test-artifacts/market-terms-recovery/${width}-${theme}-recovered.png`});
      await page.evaluate(() => window.recoveryPanel.dispose());
      await page.close();
    }
  } finally { await browser.close(); await server.close(); }
});
