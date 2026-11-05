import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
});

test('Tour planner filters its library and refreshes', async ({ page }) => {
  await page.goto('/tours');
  await expect(page.locator('#planner-updated')).not.toHaveText('Updating…', { timeout: 27000 });
  await expect(page.locator('#tour-library-state')).toBeEmpty();
  await expect(page.locator('#tour-library-state')).not.toContainText('unavailable');
  await page.locator('#tour-filter').fill('V2 no tour 35f9009c');
  await expect(page.locator('.tour-button')).toHaveCount(0);
  await expect(page.locator('#upcoming-tours')).toContainText('No matching tours');
  await page.locator('#tour-filter').fill('');
  await page.getByRole('button', { name: 'Refresh tours', exact: true }).click();
  await expect(page.locator('#planner-updated')).toContainText('Updated');
});

test('Tours opens deal workspaces and preserves legacy itinerary access', async ({page}) => {
  await page.goto('/tours');
  await expect(page.locator('#planner-updated')).not.toHaveText('Updating…', {timeout:27000});
  await expect(page.locator('#create-tour-form, #plan-form')).toHaveCount(0);
  const rows = page.locator('.tour-button');
  test.skip(await rows.count() === 0, 'Staging has no saved tour.');
  await expect(rows.first()).toHaveAttribute('href', /(?:deals\?deal=|route-editor\.html\?tour=)/);
});
