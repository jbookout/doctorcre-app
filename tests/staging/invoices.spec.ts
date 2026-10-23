import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Invoices switch all statuses and inspect original invoice facts', async ({ page }) => {
  await page.goto('/invoices');
  await expect(page.locator('.invoice-row').first()).toBeVisible();
  for (const name of ['Unpaid', 'Awaiting invoice', 'Paid', 'All']) {
    const button = page.getByRole('group', { name: 'Invoice status', exact: true }).getByRole('button', { name, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  await page.locator('.invoice-row').first().click();
  await expect(page.locator('#invoiceDetail')).toBeVisible();
  await page.locator('#invoiceOriginal summary').click();
  await expect(page.locator('#invoiceOriginalFacts')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Close invoice', exact: true }).click();
  await expect(page.locator('#invoiceDetail')).toBeHidden();
});

test('Invoices search, reset and refresh without marking a payment', async ({ page }) => {
  await page.goto('/invoices');
  await expect(page.locator('.invoice-row').first()).toBeVisible();
  const sidebar = page.getByRole('button', { name: 'Workspace sidebar', exact: true });
  if (await sidebar.getAttribute('aria-expanded') !== 'true') await sidebar.click();
  await page.locator('#invoiceSearch').fill('V2 no invoice 35f9009c');
  await expect(page.locator('.invoice-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.locator('.invoice-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'Refresh invoices', exact: true }).click();
  await expect(page.locator('#invoiceRows')).toHaveAttribute('aria-busy', 'false');
});
