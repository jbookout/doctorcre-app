import { test, expect } from '@playwright/test';

test.describe.configure({ retries: 0 });

test('Updates reads the feed, quiet-hours preferences and original version', async ({ page }) => {
  await page.goto('/updates');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#feedState')).not.toHaveAttribute('data-state', 'loading', { timeout: 27000 });
  await expect(page.locator('#feedState')).not.toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#prefForm')).toBeVisible({ timeout: 27000 });
  await page.locator('#prefForm summary').click();
  await expect(page.locator('#prefVersion')).toContainText('Version');
  const original = await page.locator('#quietStart').inputValue();
  await page.locator('#quietStart').fill('11:59 PM');
  await page.locator('#quietStart').fill(original);
  await page.locator('#retryRead').click();
  await expect(page.locator('#feedState')).not.toHaveAttribute('data-state', 'loading', { timeout: 27000 });
});

test('The staging test account timezone can be saved and restored', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/updates');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#prefForm')).toBeVisible({ timeout: 27000 });
  const original = await page.locator('#quietTimezone').inputValue();
  const modified = original === 'UTC' ? 'America/Chicago' : 'UTC';
  try {
    await page.locator('#quietTimezone').fill(modified);
    await page.locator('#prefSave').click();
    await expect(page.locator('#prefMessage')).toContainText(/^saved$/i, { timeout: 27000 });
    await page.reload();
    await expect(page.locator('#quietTimezone')).toHaveValue(modified, { timeout: 27000 });
  } finally {
    await page.reload();
    await expect(page.locator('#prefForm')).toBeVisible({ timeout: 27000 });
    if (await page.locator('#quietTimezone').inputValue() === modified) {
      await page.locator('#quietTimezone').fill(original);
      await page.locator('#prefSave').click();
      await expect(page.locator('#prefMessage')).toContainText(/^saved$/i, { timeout: 27000 });
    }
    await page.reload();
    await expect(page.locator('#quietTimezone')).toHaveValue(original, { timeout: 27000 });
  }
});
