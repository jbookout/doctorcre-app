import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Leads search narrows and clears the loaded board', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.locator('.lead-card').first()).toBeVisible();
  const sidebar = page.getByRole('button', { name: 'Workspace sidebar', exact: true });
  if (await sidebar.getAttribute('aria-expanded') !== 'true') await sidebar.click();
  await page.getByRole('searchbox', { name: 'Search leads', exact: true }).fill('V2 no matching lead 35f9009c');
  await expect(page.locator('.lead-card')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search leads', exact: true }).fill('');
  await expect(page.locator('.lead-card').first()).toBeVisible();
  await expect(page.locator('#leadBoardError')).toBeHidden();
});

test('Lead details open and close without claiming or changing a stage', async ({ page }) => {
  await page.goto('/leads');
  await page.locator('.lead-card').first().click();
  await expect(page.getByRole('dialog', { name: /.+/ }).first()).toBeVisible();
  await expect(page.locator('#detailTitle')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Close lead details', exact: true }).click();
  await expect(page.locator('#leadDetail')).toBeHidden();
  await page.locator('.lead-card').first().click();
  await page.locator('#detailStage').selectOption('engaged');
  await expect(page.locator('#stageDialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel stage change', exact: true }).click();
  await expect(page.locator('#stageDialog')).toBeHidden();
  await expect(page.locator('#leadDetail')).toBeHidden();
});

test('Lead owner and stage filters preserve a usable board', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.locator('.lead-card').first()).toBeVisible();
  const sidebar = page.getByRole('button', { name: 'Workspace sidebar', exact: true });
  if (await sidebar.getAttribute('aria-expanded') !== 'true') await sidebar.click();
  await page.locator('#ownerFilter').selectOption('joe');
  await expect(page.locator('#ownerFilter')).toHaveValue('joe');
  await page.locator('#ownerFilter').selectOption('');
  await page.locator('#stageFilter').selectOption({ index: 1 });
  await expect(page.locator('#filterSummary')).not.toBeEmpty();
  await page.locator('#stageFilter').selectOption('');
  await expect(page.locator('.lead-card').first()).toBeVisible();
});
