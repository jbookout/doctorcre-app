import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('W14 Relationships opens a party with its evidence and filters by territory', async ({ app, browser }) => {
  await app.open('/relationships');

  const lender = browser.locator('#networkNodes [data-node="party:demo-lender"]');
  await expect(lender).toBeVisible();
  await lender.tap();
  const dialog = browser.locator('.relationship-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Demo Healthcare Lending');
  await expect(dialog).toContainText('Can introduce');
  await browser.locator('.relationship-dialog details[data-entry="demo-offer"] summary').tap();
  await expect(browser.locator('.relationship-dialog details[data-entry="demo-offer"]')).toContainText('Original synthetic email');
  await browser.locator('.relationship-dialog [data-close-card]').tap();
  await expect(browser.locator('.relationship-dialog')).toBeHidden();
  await expect(dialog).toBeHidden();

  await browser.locator('#referralsTab').tap();
  await expect(browser.locator('.relationship-referral')).toHaveCount(2);
  await expect(browser.locator('#networkReferrals')).toContainText('100% win rate');
  if (await browser.locator('#appSidebar').isHidden()) await browser.locator('#appSidebarToggle').tap();
  await browser.locator('#networkTerritory').selectOption('Demo Inland');
  await expect(browser.locator('.relationship-referral')).toHaveCount(0);
  await browser.locator('#networkReset').tap();
  await expect(browser.locator('.relationship-referral')).toHaveCount(2);
});
