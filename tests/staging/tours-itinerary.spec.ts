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
  const library = await page.request.get('/api/tours/library');
  expect(library.ok()).toBe(true);
  const { data: { tours } } = await library.json();
  const tour = tours.find((row: { name: string }) => row.name === 'Synthetic staging QA accepted tour');
  expect(tour, 'staging must contain the synthetic accepted tour').toBeDefined();
  const response = await page.request.get(`/api/tours/detail?tour_id=${tour.id}`);
  expect(response.ok()).toBe(true);
  const { data } = await response.json();
  const route = data.routes.find((row: { id: string }) => row.id === data.route_version_id);
  expect(route.accepted).toBe(true);
  expect(route.stops).toHaveLength(2);
  const fixture = { tour: { ...tour, route_id: route.id,
    property_ids: route.stops.map((stop: { property_id: string }) => stop.property_id),
    stop_ids: route.stops.map((stop: { id: string }) => stop.id),
    property_names: ['Synthetic Harbor Office', 'Synthetic Garden Office'],
    projection_id: data.projection_id,
    unrelated_property_id: process.env.E2E_UNRELATED_PROPERTY_ID,
  } };
  const before = await acceptedRoute(page.request, fixture);
  await page.goto(`/tours/route-editor.html?tour=${fixture.tour.id}`);
  await expect(page.locator('#tour-name')).toHaveAttribute('title', fixture.tour.name, { timeout: 27000 });
  const stops = page.locator('#route-stops .composer-stop');
  await expect(stops).toHaveCount(2);
  expect(await stops.evaluateAll(nodes => nodes.map(node => node.dataset.propertyId))).toEqual(fixture.tour.property_ids);
  await page.locator('#route-editing > summary').click();
  await stops.first().locator('[data-field="route_label"]').fill('X');
  await page.locator('#reload-composer').click();
  await expect(page.locator('#composer-state')).toHaveText('Saved route reloaded. Local edits were discarded.');
  await expect(stops.first().locator('[data-field="route_label"]')).toHaveValue('A');
  await expect(stops.last().locator('[data-field="route_label"]')).toHaveValue('B');
  expect(await stops.evaluateAll(nodes => nodes.map(node => node.dataset.propertyId))).toEqual(fixture.tour.property_ids);
  await page.reload();
  await expect(stops).toHaveCount(2, { timeout: 27000 });
  expect(await stops.evaluateAll(nodes => nodes.map(node => node.dataset.propertyId))).toEqual(fixture.tour.property_ids);
  expect(await acceptedRoute(page.request, fixture)).toEqual(before);
});

async function acceptedRoute(request: import('@playwright/test').APIRequestContext, fixture: { tour: { id: string; route_id: string; property_ids: string[]; stop_ids: string[] } }) {
  const response = await request.get(`/api/tours/detail?tour_id=${fixture.tour.id}`);
  expect(response.ok()).toBe(true);
  const { data } = await response.json();
  const route = data.routes.find((route: { id: string }) => route.id === fixture.tour.route_id);
  expect(route?.accepted).toBe(true);
  expect(data.route_version_id).toBe(fixture.tour.route_id);
  expect(route.stops.map((stop: { property_id: string; id: string; route_sequence: number; route_label: string }) => stop.property_id)).toEqual(fixture.tour.property_ids);
  expect(route.stops.map((stop: { property_id: string; id: string; route_sequence: number; route_label: string }) => stop.id)).toEqual(fixture.tour.stop_ids);
  expect(route.stops.map((stop: { property_id: string; id: string; route_sequence: number; route_label: string }) => stop.route_sequence)).toEqual([1, 2]);
  expect(route.stops.map((stop: { property_id: string; id: string; route_sequence: number; route_label: string }) => stop.route_label)).toEqual(['A', 'B']);
  return route;
}
