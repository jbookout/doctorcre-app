import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// W9: a deal's addressable popup shows its recorded phase dates and accepts a
// contract date with its evidence.
test('W9 deal timeline shows recorded phase dates and adds a contract date', async ({ app, browser, screen }) => {
  await app.open('/deals?deal=d14');

  await expect(browser.locator('#panelTitle')).toContainText('Demo Surgical Practice');
  await expect(browser.locator('#timelineRange')).toHaveValue('full');
  await expect(browser.locator('.phase-rail [aria-current] time')).toHaveText('Jan 10, 2026');

  await browser.locator('[data-add-date="rent_start"]').tap();
  await expect(browser.locator('#dealDateDialog')).toBeVisible();
  await browser.locator('#dealDateForm [name="date"]').fill('2031-12-01');
  await browser.locator('#dealDateForm [name="evidence"]').fill('Demo lease clause 4');
  await browser.locator('#dealDateForm button[type="submit"]').tap();
  await expect(browser.locator('#dealDateDialog')).toBeHidden();
  await expect(browser.locator('[data-countdown="2031-12-01"]')).toHaveCount(1);
  await expect(browser.locator('[data-add-date="rent_start"]')).toHaveCount(0);

  await screen.getByLabel('Close deal', { exact: true }).tap();
  await expect(browser.locator('#recordPanel')).toBeHidden();
  await browser.waitForURL(/\/deals$/);
});
