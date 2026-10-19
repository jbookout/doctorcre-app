import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Relationships switch referrals/network and inspect a connection', async ({ page }) => {
  await page.goto('/relationships');
  await expect(page.locator('#networkNodes [data-node]').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Referrals', exact: true }).click();
  await expect(page.locator('#referralsView')).toBeVisible();
  await page.getByRole('tab', { name: 'Network', exact: true }).click();
  await page.locator('#networkNodes [data-node]').first().click();
  await expect(page.getByRole('dialog').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Relationships search and clear filters after zoom and fit', async ({ page }) => {
  await page.goto('/relationships');
  await expect(page.locator('#networkNodes [data-node]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  const sidebar = page.getByRole('button', { name: 'Workspace sidebar', exact: true });
  if (await sidebar.getAttribute('aria-expanded') !== 'true') await sidebar.click();
  await page.locator('#networkSearch').fill('V2 no connection 35f9009c');
  await expect(page.locator('#networkNodes [data-node]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.locator('#networkNodes [data-node]').first()).toBeVisible();
});

