import { test, expect } from '@playwright/test';
import { requireStagingAuthority, withJourneyFixture } from './journey-fixture.mjs';
import { itinerary } from './journey-flows.mjs';

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
  test.setTimeout(420000);
  await requireStagingAuthority(page.request);
  await withJourneyFixture(fixture => itinerary(page, fixture));
});
