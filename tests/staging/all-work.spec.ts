import { test, expect } from '@playwright/test';

test('All Work filters types and status, then reads record evidence', async ({ page }) => {
  await page.goto('/all-work');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#censusStatusLabel')).toContainText('Census', { timeout: 27000 });
  await expect(page.locator('#censusStatusLabel')).not.toContainText('unavailable');
  await page.locator('#kindChips [data-kind=loop]').click();
  await expect(page.locator('#kindChips [data-kind=loop]')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#kindReset').click();
  await expect(page.locator('#kindChips [data-kind=loop]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#statusFilter').fill('V2 no status 35f9009c');
  await page.locator('#statusFilter').fill('');
  const evidence = page.locator('#stageRows [data-evidence]').first();
  if (await evidence.count()) {
    await evidence.click();
    await expect(page.locator('#evidenceDialog')).toBeVisible();
    await expect(page.locator('#evidenceRows')).not.toBeEmpty();
    await page.locator('#evidenceClose').click();
  }
});
