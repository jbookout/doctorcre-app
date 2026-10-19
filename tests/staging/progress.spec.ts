import { test, expect } from '@playwright/test';

test('Progress directory opens a published board and filters its pipeline', async ({ page }) => {
  await page.goto('/control-room/progress');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#board-directory a').first()).toBeAttached({ timeout: 27000 });
  const href = await page.locator('#board-directory a').first().getAttribute('href');
  if (!href) throw new Error('Published board link has no address');
  await page.goto(href);
  await expect(page).toHaveURL(/\/control-room\/progress\/board\//);
  await expect(page.locator('#board-meta')).not.toHaveText('Loading published board…', { timeout: 27000 });
  await expect(page.locator('#board-error')).toBeHidden();
  await page.locator('#legend-toggle').click();
  await expect(page.locator('#legend')).toBeVisible();
  await page.locator('#legend-toggle').click();
  await page.locator('#filter-blocked').check();
  await expect(page.locator('#filter-blocked')).toBeChecked();
  await page.locator('#filter-blocked').uncheck();
  const stages = page.locator('#filter-stage option');
  if (await stages.count() > 1) {
    await page.locator('#filter-stage').selectOption({ index: 1 });
    await expect(page.locator('#filter-stage')).not.toHaveValue('');
    await page.locator('#filter-stage').selectOption('');
  }
  await expect(page.locator('#board-activity')).toHaveAttribute('href', /progress\/work\?board=/);
});
