import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Calendar switches periods, week/month and selects a day', async ({ page }) => {
  await page.goto('/calendar');
  await expect(page.locator('.cal-day-open').first()).toBeVisible();
  const period = await page.locator('#calPeriod').innerText();
  await page.locator('#calNext').click();
  await expect(page.locator('#calPeriod')).not.toHaveText(period);
  await page.locator('#calPrev').click();
  await expect(page.locator('#calPeriod')).toHaveText(period);
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.locator('#calGrid')).toHaveAttribute('data-view', 'week');
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await page.locator('.cal-day-open').first().click();
  await expect(page.locator('#dayPanelTitle')).not.toHaveText('Choose a day');
  await page.locator('#calToday').click();
  await expect(page.locator('[data-today="true"]')).toBeVisible();
});

test('Calendar agenda opens the selected date details', async ({ page }) => {
  await page.goto('/calendar');
  await page.locator('.cal-agenda-item').first().click();
  await expect(page.locator('#dayPanelBody .cal-day-entry').first()).toBeVisible();
});

