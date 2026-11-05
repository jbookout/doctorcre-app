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
  const response = await page.request.get('/api/v1/business/leases');
  expect(response.ok()).toBe(true);
  const envelope = await response.json();
  const { leases } = envelope.data ?? envelope;
  const lease = leases.find((row: { client_name: string }) => /^Synthetic staging QA .* lease$/.test(row.client_name));
  expect(lease, 'staging must contain the synthetic lease').toBeDefined();
  const fixture = { lease };
  await page.goto('/leases?mode=live');
  const card = page.locator(`#leaseRadar [data-lease="${fixture.lease.id}"]`);
  await expect(card).toContainText(fixture.lease.client_name, { timeout: 27000 });
  await card.click();
  await expect(page.locator('#leaseDetail')).toBeVisible();
  await expect(page.locator('#leaseDetailTitle')).toHaveText(fixture.lease.client_name);
  await expect(page.locator('#leaseDetail a[data-radar-key="client"]')).toHaveAttribute('href', `/clients?record=${fixture.lease.client_id}`);
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
