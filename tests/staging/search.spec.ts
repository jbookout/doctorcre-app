import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('V2-A01: Global Search returns results for a synthetic record term', async ({ page }) => {
  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Name to search', exact: true }).fill('Synthetic');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/q=Synthetic/);
  await expect(page.locator('#searchResults')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#searchState')).not.toHaveAttribute('data-state', /error|loading|unknown|unavailable/);
  await expect(page.locator('#searchCount')).not.toBeEmpty();
});

test('Search saves and resets a browser-local view', async ({ page }) => {
  await page.goto('/search');
  await page.getByRole('textbox', { name: 'Name for this view', exact: true }).fill('V2 staging view');
  await page.getByRole('button', { name: 'Save this view', exact: true }).click();
  await expect(page.locator('#savedViewList')).toContainText('V2 staging view');
  await page.reload();
  await expect(page.locator('#savedViewList')).toContainText('V2 staging view');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.locator('#savedViewList')).not.toContainText('V2 staging view');
});
