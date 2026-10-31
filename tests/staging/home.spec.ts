import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Home reads a complete partner inbox and can refresh', async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh inbox', exact: true })).toBeEnabled({ timeout: 27000 });
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await expect(page.locator('.inbox-health')).toContainText('Up to date', { timeout: 27000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('V2-F03: Charts navigation opens, selects and returns to Overview', async ({ page }) => {
  await page.goto('/?view=charts');
  await expect(page.locator('.chart-card').first()).toBeVisible();
  await page.locator('.chart-pick').first().click();
  await expect(page.locator('.chart-pick[aria-pressed="true"]').first()).toBeVisible();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
});

test('Home card deep link keeps a current inbox item reachable', async ({ page }) => {
  await page.goto('/home');
  const card = page.locator('[data-inbox-row] h3 a').first();
  test.skip(await card.count() === 0, 'The signed-in synthetic actor has no inbox cards.');
  const href = await card.getAttribute('href');
  await card.click();
  await expect(page).toHaveURL(href);
  await expect(page.getByRole('heading', { name: 'Current card', exact: true })).toBeVisible();
});
