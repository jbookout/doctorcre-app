import { test, expect } from '@playwright/test';

test('Share without a confidential link reveals no properties or feedback controls', async ({ page }) => {
  await page.goto('/share');
  await expect(page.locator('#status')).not.toBeEmpty({ timeout: 27000 });
  await expect(page.locator('#report-list li')).toHaveCount(0);
  await expect(page.locator('#open-tour')).toBeDisabled();
});
