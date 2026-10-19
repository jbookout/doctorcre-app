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

test('Itinerary selects an accepted tour and reloads its route without saving', async ({ page }) => {
  await page.goto('/tours/route-editor.html');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#tour-list')).toHaveAttribute('aria-busy', 'false', { timeout: 27000 });
  test.skip(await page.locator('.tour-button').count() === 0, 'Staging has no itinerary to inspect.');
  const library = await page.request.get('/api/tours/library');
  expect(library.ok()).toBe(true);
  const { data } = await library.json();
  expect(data.tours).toEqual(expect.any(Array));
  const details = await Promise.all(data.tours.map(async (tour: { id: string }) => {
    expect(tour.id).toEqual(expect.any(String));
    const response = await page.request.get(`/api/tours/detail?tour_id=${encodeURIComponent(tour.id)}`);
    expect(response.ok()).toBe(true);
    return (await response.json()).data;
  }));
  const accepted = details.find(tour => tour.route_version_state === 'accepted');
  test.skip(!accepted, 'Staging has no accepted itinerary; untouched drafts intentionally hide Reload saved route.');
  await page.goto(`/tours/route-editor.html?tour=${encodeURIComponent(accepted.id)}`);
  await expect(page.locator('#tour-name')).not.toHaveText('Tour', { timeout: 27000 });
  await expect(page.locator('#reload-composer')).toBeVisible();
  await page.locator('#reload-composer').click();
  await expect(page.locator('#composer-state')).toHaveText('Saved route reloaded. Local edits were discarded.');
  await expect(page.locator('#tour-name')).toHaveAttribute('title', accepted.name);
});
