import { expect } from 'e2e';
import { reproTest } from '../support.mjs';
const test = reproTest();

test('QA-022 leases retain ownership, search and view after reload', { tags: ['regression'] }, async ({ app, browser, screen }) => {
  await app.open('/leases');
  const phone = await browser.evaluate(() => innerWidth < 760);
  if (phone) await browser.locator('#appSidebarToggle').tap();
  await screen.getByLabel('Leases').selectOption({ label: 'Mine' });
  await screen.getByLabel('Client', { exact: true }).fill('Demo Practice 9');
  if (phone) await browser.locator('[data-layout-close="sidebar"]').tap();
  await screen.getByRole('button', 'Missing dates', { exact: true }).tap();
  await expect(screen.getByRole('button', 'Demo Practice 9', { exact: false })).toBeVisible();
  await browser.reload();
  if (phone) await browser.locator('#appSidebarToggle').tap();
  expect.soft(await screen.getByLabel('Leases').inputValue()).toBe('mine');
  expect.soft(await screen.getByLabel('Client', { exact: true }).inputValue()).toBe('Demo Practice 9');
  await expect.soft(screen.getByRole('button', 'Missing dates', { exact: true })).toHaveAttribute('aria-pressed', 'true');
});
