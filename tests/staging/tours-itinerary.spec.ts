import { test, expect } from '@playwright/test';

test('Itinerary reads its library and opens an unsaved creation form', async ({ page }) => {
  await page.goto('/tours/route-editor.html');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#tour-list')).toHaveAttribute('aria-busy', 'false', { timeout: 27000 });
  await page.locator('#create-tour-panel summary').click();
  await page.getByRole('textbox', { name: 'Tour name', exact: true }).fill('V2 discarded itinerary');
  await page.locator('#create-subject-type').selectOption('work');
  await page.locator('#create-tour-panel summary').click();
  await expect(page.locator('#create-tour-form')).toBeHidden();
});

test('Itinerary selects a saved tour and reloads its route without saving', async ({ page }) => {
  await page.goto('/tours/route-editor.html');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#tour-list')).toHaveAttribute('aria-busy', 'false', { timeout: 27000 });
  test.skip(await page.locator('.tour-button').count() === 0, 'Staging has no itinerary to inspect.');
  const sidebar = page.getByRole('button', { name: 'Workspace sidebar', exact: true });
  if (await sidebar.getAttribute('aria-expanded') !== 'true') await sidebar.click();
  await page.locator('.tour-button').first().click();
  await expect(page.locator('#tour-name')).not.toHaveText('Tour', { timeout: 27000 });
  await page.locator('#reload-composer').click();
  await expect(page.locator('#tour-name')).not.toBeEmpty();
});
