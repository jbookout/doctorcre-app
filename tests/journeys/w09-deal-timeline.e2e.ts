import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('W9 deal timeline shows recorded phase dates and expandable update history', async ({ app, browser, screen }) => {
  await app.open('/deals?deal=d14');

  await expect(browser.locator('#panelTitle')).toContainText('Demo Surgical Practice');
  await expect(browser.locator('[aria-label="Deal phases and timeline"]')).toBeVisible();
  await expect(browser.locator('.phase-rail [aria-current] time')).toHaveText('Jan 10, 2026');
  await expect(browser.locator('.phase-rail li small')).toHaveCount(0);
  await expect(browser.locator('.updates-overview')).toBeVisible();
  await expect(browser.locator('.deal-dates,.full-record,[data-jev-deal]')).toHaveCount(0);
  await browser.locator('.updates-history > summary').tap();
  await expect(browser.locator('.deal-note').first()).toBeVisible();

  await screen.getByRole('button', { name: 'Back to deals', exact: true }).tap();
  await expect(browser.locator('#recordPanel')).toBeHidden();
  await browser.waitForURL(/\/deals$/);
});
