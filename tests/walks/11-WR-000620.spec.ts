import { expect } from '@playwright/test';
import { test } from './privacy';
import { designated, needs } from './ui';

test("11 WR-000620", async ({ page }) => {
  await page.goto('/updates');
  await expect(page.locator('#feedState')).toHaveAttribute('data-state', /^(ready|empty|no_match|unavailable|refused|unknown)$/);
  await expect(page.locator('#feedState')).toHaveAttribute('data-state', /^(ready|empty|no_match)$/);
  const notification = page.locator('article, li').filter({ hasText: designated }).filter({ has: page.locator('a[href*="doc-chats"]') }).first();
  needs(!await notification.count(), 'completed TEST Doc notification with stored answer link');
  const link = notification.locator('a[href*="doc-chats"]').first();
  const href = await link.getAttribute('href');
  await link.click();
  await page.waitForLoadState('domcontentloaded');
  expect(new URL(page.url()).pathname === new URL(href!, 'https://app.doctorcre.com').pathname).toBe(true);
  await page.reload();
  expect(await page.locator('.answer-table, .doc-message, [data-message-id]').count() > 0).toBe(true);
  needs(true, 'completed notification and rendered answer exposing the same stored request ID for readback');
});
