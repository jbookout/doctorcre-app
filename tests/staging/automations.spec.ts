import { test, expect } from '@playwright/test';

test('Automations reads schedules and opens job history without running a job', async ({ page }) => {
  await page.goto('/control-room/automations');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page).toHaveURL(/control-room\?tab=automations/);
  await expect(page.locator('#panelAutomations')).toBeVisible();
  const job = page.locator('.automation-job').first();
  await expect(job).toBeVisible();
  await job.click();
  await expect(page.locator('#jobDialog')).toBeVisible();
  await expect(page.locator('#jobTitle')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Close job details', exact: true }).click();
  await expect(page.locator('#jobDialog')).toBeHidden();
});
