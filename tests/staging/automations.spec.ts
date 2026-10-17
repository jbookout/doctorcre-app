import { test, expect } from '@playwright/test';

test('Automations reads schedules and opens job history without running a job', async ({ page }) => {
  await page.goto('/control-room/automations');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#listUpdated')).toContainText('Updated', { timeout: 27000 });
  const job = page.locator('.automation-job').first();
  test.skip(await job.count() === 0, 'Staging has no automation schedule to inspect.');
  await job.click();
  await expect(page.locator('#jobDialog')).toBeVisible();
  await expect(page.locator('#jobTitle')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Close job details', exact: true }).click();
  await expect(page.locator('#jobDialog')).toBeHidden();
});
