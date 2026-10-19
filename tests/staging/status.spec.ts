import { test, expect } from '@playwright/test';

test('Status reads coverage and exposes provider status links', async ({ page }) => {
  await page.goto('/status');
  await expect(page.locator('#statusHeadline')).not.toHaveText('Updating…', { timeout: 27000 });
  await expect(page.locator('#statusChips')).not.toBeEmpty();
  await expect(page.locator('#providerLinks a').first()).toBeVisible();
});
