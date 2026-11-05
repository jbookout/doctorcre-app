import { test, expect } from '@playwright/test';
import './privacy';
import { card } from './ui';

test("35 unit:inbox-safe-refresh", async ({ page }) => {
  const row = await card(page);
  const id = await row.getAttribute('data-inbox-row');
  const link = row.locator('h3 a');
  await link.click();
  await link.focus();
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await expect.poll(() => page.getByRole('button', { name: 'Refresh inbox', exact: true }).isEnabled()).toBe(true);
  expect(await row.getAttribute('data-inbox-row') === id).toBe(true);
  expect(await page.locator('[data-current] h3 a').count()).toBe(1);
  expect(await link.evaluate(node => document.activeElement === node)).toBe(true);
  await page.context().clearCookies();
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await expect.poll(() => page.locator('[data-inbox-row] button').count()).toBe(0);
});
