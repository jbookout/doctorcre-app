import { test, expect } from '@playwright/test';

test('Observatory reads the room, focuses signals and refreshes its conversation', async ({ page }) => {
  await page.goto('/control-room/observatory');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#presenceText')).not.toHaveText('Reading the wire…', { timeout: 27000 });
  await expect(page.locator('#nowDialogue')).not.toContainText('Reading the latest conversation');
  await expect(page.locator('#freshness')).not.toContainText(/unavailable|Connecting/);
  for (const signal of ['running', 'attention', 'finished']) {
    await page.locator('button[data-focus=' + signal + ']').click();
    await expect(page.locator('#' + signal + 'Panel')).toBeVisible();
  }
  await page.locator('#refreshButton').click();
  await expect(page.locator('#currentThread')).not.toContainText('Reading turns');
});
