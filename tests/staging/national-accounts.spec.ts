import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('National accounts load and inspect the account portfolio', async ({ page }) => {
  await page.goto('/deals?view=national');
  await expect(page.locator('.account-card').first()).toBeVisible();
  await page.locator('.account-card').first().click();
  await expect(page.locator('#accountGrid')).toBeHidden();
  await expect(page.locator('#rows tr').or(page.locator('#emptyState')).first()).toBeVisible();
  await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'All national accounts' }).click();
  await expect(page.locator('.account-card').first()).toBeVisible();
});

test('National work records can be searched without changing records', async ({ page }) => {
  await page.goto('/deals?view=national');
  await expect(page.locator('.account-card').first()).toBeVisible();
  await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
  await page.locator('#search').fill('V2 no matching work 35f9009c');
  await expect(page.locator('#rows tr')).toHaveCount(0);
  await expect(page.locator('#emptyState')).toBeVisible();
  await page.locator('#search').fill('');
  await expect(page.locator('.account-card').first()).toBeVisible();
});
