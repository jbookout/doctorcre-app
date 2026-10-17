import { test, expect } from '@playwright/test';

test('Progress work reads project evidence and searches sessions without dispatch', async ({ page }) => {
  await page.goto('/control-room/progress/work?board=carr-v5');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#workReadState')).not.toHaveText('Loading…', { timeout: 27000 });
  await expect(page.locator('#workReadState')).not.toContainText('Work evidence unavailable');
  await page.locator('#workSessionQuery').fill('V2 no session 35f9009c');
  await page.locator('#workSessionSearch button').click();
  await expect(page.locator('#workSessionList')).not.toBeEmpty();
  for (const section of ['#workSessions', '#workReviews', '#workDot', '#workTasks']) {
    await expect(page.locator(section)).toBeVisible();
  }
});

test.fixme('V2-E01: Progress work cannot establish the publication update time', { tag: '@fixme' }, async ({ page }) => {
  await page.goto('/control-room/progress/work?board=carr-v5');
  await expect(page.locator('#workReadState')).not.toHaveText('Loading…', { timeout: 27000 });
  await expect(page.locator('#workReadState')).not.toContainText('unavailable');
});
