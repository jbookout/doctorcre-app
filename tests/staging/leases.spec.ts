import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Leases switch missing dates and timeline', async ({ page }) => {
  await page.goto('/leases');
  await expect(page.locator('#leaseUpdated')).toContainText('Updated', { timeout: 27000 });
  await page.getByRole('button', { name: 'Missing dates', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Missing dates', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Lease timeline', exact: true }).click();
  await expect(page.locator('#leaseRadar')).toBeVisible();
});

test('A lease opens and closes its details', async ({ page }) => {
  await page.goto('/leases');
  await expect(page.locator('#leaseUpdated')).toContainText('Updated', { timeout: 27000 });
  const lease = page.locator('#leaseRadar [data-lease]').first();
  test.skip(await lease.count() === 0, 'Staging has no lease in the radar window; detail requires a test record.');
  await lease.click();
  await expect(page.locator('#leaseDetail')).toBeVisible();
  await expect(page.locator('#leaseDetailTitle')).not.toBeEmpty();
  await page.keyboard.press('Escape');
  await expect(page.locator('#leaseDetail')).toBeHidden();
});

test('Leases search, clear, scope to mine and refresh', async ({ page }) => {
  await page.goto('/leases');
  await expect(page.locator('#leaseUpdated')).toContainText('Updated', { timeout: 27000 });
  const sidebar = page.getByRole('button', { name: 'Workspace sidebar', exact: true });
  if (await sidebar.getAttribute('aria-expanded') !== 'true') await sidebar.click();
  await page.locator('#leaseSearch').fill('V2 no lease 35f9009c');
  await expect(page.locator('#leaseRadar [data-lease]')).toHaveCount(0);
  await page.locator('#leaseSearch').fill('');
  await page.locator('#leaseScope').selectOption('mine');
  await expect(page.locator('#leaseScope')).toHaveValue('mine');
  await page.locator('#leaseScope').selectOption('team');
  await page.getByRole('button', { name: 'Refresh lease dates', exact: true }).click();
  await expect(page.locator('#leaseUpdated')).toContainText('Updated', { timeout: 27000 });
});

