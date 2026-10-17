import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Local Deals switches board and list views and inspects a deal', async ({ page }) => {
  await page.goto('/deals');
  await expect(page.locator('.card-open').first()).toBeVisible();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.locator('#listView')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.locator('#boardView')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.card-open').first().click();
  await expect(page.locator('#recordPanel')).toBeVisible();
  await expect(page.locator('#panelTitle')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Close deal', exact: true }).click();
  await expect(page.locator('#recordPanel')).toBeHidden();
});

test('Local Deals shows parked records and recent changes read-only', async ({ page }) => {
  await page.goto('/deals');
  await expect(page.locator('.card-open').first()).toBeVisible();
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  await expect(page.locator('#parkedToggle')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Parked', exact: true }).click();
  await expect(page.locator('#parkedToggle')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Today sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Today sidebar', exact: true }).click();
  await expect(page.locator('#appToday')).toBeVisible();
});
