import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Doc Activity filters by partner/date, clears and refreshes', async ({ page }) => {
  await page.goto('/doc-activity');
  await expect(page.locator('#activityUpdated')).toContainText('Updated', { timeout: 27000 });
  await page.getByRole('combobox', { name: 'Partner', exact: true }).selectOption('joe');
  await page.locator('#activityFilters input[name=from]').fill('2026-10-01');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Partner', exact: true })).toHaveValue('');
  await expect(page.locator('#activityFilters input[name=from]')).toHaveValue('');
  await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  await expect(page.locator('#activityStatus')).not.toContainText('unavailable');
});

test('Doc Activity opens original evidence without undoing the action', async ({ page }) => {
  await page.goto('/doc-activity');
  await expect(page.locator('#activityUpdated')).toContainText('Updated', { timeout: 27000 });
  const entry = page.locator('#activityFeed [data-open]').first();
  test.skip(await entry.count() === 0, 'Staging has no activity entry to inspect.');
  await entry.click();
  await expect(page.locator('#activityDetail')).toBeVisible();
  await page.locator('#detailOriginal summary').click();
  await expect(page.locator('#detailOriginalText')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Close activity', exact: true }).click();
  await expect(page.locator('#activityDetail')).toBeHidden();
});
