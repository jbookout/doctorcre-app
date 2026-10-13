import { productTest } from './test.mjs';
const test = productTest();
import { expect } from 'e2e';

// W14: the relationship graph opens a party's evidence and filters by territory.
test('W14 relationship graph opens a party with its evidence and filters by territory', async ({ app, browser, quality }) => {
  await app.open('/relationships');

  const lender = browser.locator('.relationship-node[data-node="party:demo-lender"]');
  await expect(lender).toBeVisible();
  await quality.check('relationships');
  await lender.tap();
  const dialog = browser.locator('.relationship-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Demo Healthcare Lending');
  await expect(dialog).toContainText('Can introduce');
  await browser.locator('.relationship-dialog details[data-entry="demo-offer"] summary').tap();
  await expect(browser.locator('.relationship-dialog details[data-entry="demo-offer"]')).toContainText('Original synthetic email');
  await quality.check('relationship-record');
  await quality.dismiss('.relationship-dialog', '[data-close-card]');
  await expect(dialog).toBeHidden();

  await browser.locator('#referralsTab').tap();
  await expect(browser.locator('.relationship-referral')).toHaveCount(2);
  await expect(browser.locator('#networkReferrals')).toContainText('100% win rate');
  await quality.check('relationship-referrals');
  await quality.controls();
  await browser.locator('#networkTerritory').selectOption('Demo Inland');
  await expect(browser.locator('.relationship-referral')).toHaveCount(0);
  await browser.locator('#networkReset').tap();
  await expect(browser.locator('.relationship-referral')).toHaveCount(2);
});
