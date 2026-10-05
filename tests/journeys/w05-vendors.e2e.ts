import { productTest } from './test.mjs';
const test = productTest();
import { expect } from 'e2e';
import { directoryFixture } from '../../test/fixtures/vendor-directory.synthetic.mjs';

// W5: the Vendors directory filters by owner and opens a vendor's full record.
test('W5 Vendors filters by owner and opens a vendor with its original entries', async ({ app, browser, screen, quality }) => {
  await browser.route('**/api/v1/business/**', route => route.fulfill({ json: directoryFixture(route.request.url) }));
  await app.open('/vendors');

  await expect(browser.locator('#resultSummary')).toHaveText(/^62 /);
  await quality.check('vendors');
  await browser.locator('[data-owner="dell"]').tap();
  await expect(browser.locator('#resultSummary')).toHaveText(/^31 /);
  await browser.waitForURL(/owner=dell/);
  await browser.locator('#resetFilters').tap();
  await expect(browser.locator('#resultSummary')).toHaveText(/^62 /);

  await browser.locator('.record-row').first().tap();
  await expect(browser.locator('#recordPanel')).toBeVisible();
  await expect(browser.locator('#recordPanel')).toHaveAttribute('role', 'dialog');
  await expect(browser.locator('#recordBody')).toContainText('Suggested introductions');
  const intro = browser.locator('[data-details-key="intro-demo-intro"]');
  await browser.locator('[data-details-key="intro-demo-intro"] summary').tap();
  await expect(intro).toContainText('Original synthetic introduction entry');

  await quality.check('vendor-record');
  await quality.dismiss('#recordPanel', '[aria-label="Close record"]');
  await expect(browser.locator('#recordPanel')).toBeHidden();
  await expect(screen.getByRole('heading', 'Results')).toBeVisible();
});
