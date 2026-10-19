import { test, expect } from '@playwright/test';

test('Tour day reports a missing tour and disables recording', async ({ page }) => {
  await page.goto('/tours/day.html');
  await expect(page.locator('#day-status')).toHaveText('Tour unavailable', { timeout: 27000 });
  await expect(page.locator('#day-record')).toBeDisabled();
});

test('An accepted tour opens day mode, selects a stop and returns from property detail', async ({ page }) => {
  await page.goto('/tours');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#planner-updated')).not.toHaveText('Updating…', { timeout: 27000 });
  await expect(page.locator('#tour-library-state')).toBeEmpty();
  test.skip(await page.locator('.tour-button').count() === 0, 'Staging has no tour; day mode requires an accepted test route.');
  test.setTimeout(120000);
  const tours = page.locator('.tour-button');
  const total = await tours.count();
  let href: string | null = null;
  for (let index = 0; index < total; index++) {
    await tours.nth(index).click();
    await expect(page.getByRole('link', { name: 'Edit itinerary', exact: true })).toBeVisible({ timeout: 27000 });
    const day = page.getByRole('link', { name: 'Tour day', exact: true });
    if (await day.count()) { href = await day.getAttribute('href'); break; }
    await page.getByRole('button', { name: 'Close tour details', exact: true }).click();
  }
  test.skip(!href, 'No staging tour has an accepted route; its append-only writers have no fixture deletion or acceptance undo.');
  if (!href) throw new Error('Tour day link is missing its address');
  await page.goto(href);
  await expect(page.locator('#day-stops li').first()).toBeVisible({ timeout: 27000 });
  await expect(page.locator('#day-current')).not.toBeEmpty();
  await page.locator('#day-current .property-open').click();
  await expect(page.locator('#day-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close property', exact: true }).click();
  await expect(page.locator('#day-dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Next stop', exact: true }).click();
  await page.getByRole('button', { name: 'Previous stop', exact: true }).click();
});
