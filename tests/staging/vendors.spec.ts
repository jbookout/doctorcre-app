import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Vendors filter by owner, reset and search the loaded directory', async ({ page }) => {
  await page.goto('/vendors');
  await expect(page.locator('.record-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'Close Today', exact: true }).click();
  await page.locator('[data-owner="dell"]').click();
  await expect(page).toHaveURL(/owner=dell/);
  await page.locator('#resetFilters').click();
  await expect(page.locator('.record-row').first()).toBeVisible();
  await page.locator('#searchInput').fill('V2 no matching vendor 35f9009c');
  await expect(page.locator('.record-row')).toHaveCount(0);
  await page.locator('#resetFilters').click();
  await expect(page.locator('.record-row').first()).toBeVisible();
});

test('V2-A02: Vendor Reset remains available with Today open at 1280px', async ({ page }) => {
  await page.goto('/vendors');
  await expect(page.locator('.record-row').first()).toBeVisible();
  await page.locator('[data-owner="dell"]').click();
  await expect(page).toHaveURL(/owner=dell/);
  await page.locator('#resetFilters').click();
  await expect(page).toHaveURL('/vendors');
});

test('Vendors inspect relationship context and close the full record', async ({ page }) => {
  await page.goto('/vendors');
  await page.locator('.record-row').first().click();
  await expect(page.locator('#recordPanel')).toBeVisible();
  await expect(page.locator('#recordBody')).toContainText('Suggested introductions');
  await page.getByRole('button', { name: 'Close record', exact: true }).click();
  await expect(page.locator('#recordPanel')).toBeHidden();
});
