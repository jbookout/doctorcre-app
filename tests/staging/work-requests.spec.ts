import { test, expect } from '@playwright/test';

test('Work Requests reads eligible work and opens a card without approving it', async ({ page }) => {
  await page.goto('/work-requests');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#systemWorkActor')).not.toHaveText('Checking session…', { timeout: 27000 });
  await expect(page.locator('#systemWorkStage')).not.toContainText('Work Requests unavailable');
  const card = page.locator('[data-open-work-request]').first();
  await expect(card).toBeVisible({ timeout: 27000 });
  const ref = await card.getAttribute('data-open-work-request');
  await card.click();
  await expect(page.locator('#systemWorkStage')).toContainText(ref || '', { timeout: 27000 });
  await expect(page).toHaveURL(/work_request=WR-/);
});
