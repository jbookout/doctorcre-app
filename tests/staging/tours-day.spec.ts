import { test, expect } from '@playwright/test';

test('Tour day reports a missing tour and disables recording', async ({ page }) => {
  await page.goto('/tours/day.html');
  await expect(page.locator('#day-status')).toHaveText('Tour unavailable', { timeout: 27000 });
  await expect(page.locator('#day-record')).toBeDisabled();
});

test('An accepted tour opens day mode, selects a stop and returns from property detail', async ({ page }) => {
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
  await page.goto(`/tours/day.html?tour=${fixture.tour.id}`);
  const stops = page.locator('#day-stops .day-stop');
  await expect(stops).toHaveCount(2, { timeout: 27000 });
  expect(await stops.evaluateAll(nodes => nodes.map(node => node.dataset.stopId))).toEqual(fixture.tour.stop_ids);
  await expect(stops.locator('strong')).toHaveText(fixture.tour.property_names);
  await stops.nth(1).click();
  await expect(stops.nth(1)).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('#day-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close property', exact: true }).click();
  await expect(page.locator('#day-current')).toContainText(fixture.tour.property_names[1]);
  await page.locator('#day-current .property-open').click();
  await expect(page.locator('#day-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close property', exact: true }).click();
  await expect(page.locator('#day-dialog')).toBeHidden();
  await page.reload();
  await expect(stops.nth(1)).toHaveAttribute('aria-current', 'step', { timeout: 27000 });
  expect(await stops.evaluateAll(nodes => nodes.map(node => node.dataset.stopId))).toEqual(fixture.tour.stop_ids);
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
