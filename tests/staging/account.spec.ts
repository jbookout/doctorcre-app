import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Account opens Profile and returns focus; presentation toggles restore their state', async ({ page }) => {
  await page.goto('/');
  const account = page.getByRole('button', { name: 'Joe: account and settings', exact: true });
  await account.click();
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Joe');
  await page.getByRole('button', { name: 'Close profile', exact: true }).click();
  await expect(account).toBeFocused();
  const assist = page.getByRole('button', { name: 'Color assist', exact: true });
  const initial = await assist.getAttribute('aria-pressed');
  await assist.click();
  await expect(assist).not.toHaveAttribute('aria-pressed', initial || 'false');
  await assist.click();
  await expect(assist).toHaveAttribute('aria-pressed', initial || 'false');
  const theme = page.locator('#appShell [data-pref=theme]');
  const mode = await theme.getAttribute('aria-pressed');
  await theme.click();
  await expect(theme).not.toHaveAttribute('aria-pressed', mode || 'false');
  await theme.click();
  await expect(theme).toHaveAttribute('aria-pressed', mode || 'false');
  await account.click();
  await page.keyboard.press('Escape');
  await expect(account).toHaveAttribute('aria-expanded', 'false');
});

test('V2-D01: Shell clears connection health offline and restores it after reconnecting', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#appConnection')).toHaveAttribute('aria-label', 'Connection available', { timeout: 27000 });
  try {
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
    await expect(page.locator('#appConnection')).toHaveAttribute('aria-label', 'Connection unavailable', { timeout: 27000 });
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  } finally { await context.setOffline(false); }
  await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
  await expect(page.locator('#appConnection')).toHaveAttribute('aria-label', 'Connection available', { timeout: 27000 });
});

test('Doc command bar searches page navigation and opens Clients', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Doc', exact: true }).click();
  await expect(page.locator('#docDetail')).toBeVisible();
  await page.getByRole('combobox', { name: 'Search anything', exact: true }).fill('Clients');
  await page.getByRole('option', { name: /Clients/ }).first().click();
  await expect(page).toHaveURL('/clients');
  await page.locator('#listRegion[aria-busy="false"]').waitFor();
  await expect(page.locator('.record-row').first()).toBeVisible();
});
