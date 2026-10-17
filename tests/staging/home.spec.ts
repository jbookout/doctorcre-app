import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Home scope switches and refreshes loaded deal attention', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await expect(page.locator('#dealAttention')).toHaveAttribute('aria-busy', 'false', { timeout: 27_000 });
  await page.getByRole('button', { name: 'Just Me', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Just Me', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Team View', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Team View', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
  await expect(page.locator('#dealAttention')).toHaveAttribute('aria-busy', 'false', { timeout: 27_000 });
  await expect(page.locator('#observedAt')).not.toContainText(/Unavailable|Sign in/);
});

test.fixme('V2-F03: Charts navigation intermittently fails with ERR_TIMED_OUT', { tag: '@fixme' }, async ({ page }) => {
  await page.goto('/?view=charts');
  await expect(page.locator('.chart-card').first()).toBeVisible();
  await page.locator('.chart-pick').first().click();
  await expect(page.locator('.chart-pick[aria-pressed="true"]').first()).toBeVisible();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
});

test('Home deal attention opens the selected deal details', async ({ page }) => {
  await page.goto('/');
  await page.locator('#dealFlags a').first().click();
  await expect(page).toHaveURL(/\/deals\?deal=/);
  await expect(page.locator('#recordPanel')).toBeVisible();
  await expect(page.locator('#panelTitle')).not.toBeEmpty();
});
