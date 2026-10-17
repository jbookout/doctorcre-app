import { test, expect } from '@playwright/test';

test('Incidents reads the ledger and opens a recorded incident when present', async ({ page }) => {
  await page.goto('/incidents');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#listAsOf')).not.toHaveText('unknown', { timeout: 27000 });
  await expect(page.locator('#listState')).toBeHidden();
  const incident = page.locator('#incidentList a').first();
  if (await incident.count()) {
    await incident.click();
    await expect(page.locator('#detailBlock')).toBeVisible({ timeout: 27000 });
    await expect(page.locator('#whoCanClear')).not.toHaveText('unknown');
  }
});
