import { expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';

export async function leaseDetails(page, fixture) {
  await page.goto('/leases?mode=live');
  const card = page.locator(`#leaseRadar [data-lease="${fixture.lease.id}"]`);
  await expect(card).toContainText(fixture.lease.client_name, { timeout: 27000 });
  await card.click();
  await expect(page.locator('#leaseDetail')).toBeVisible();
  await expect(page.locator('#leaseDetailTitle')).toHaveText(fixture.lease.client_name);
  await expect(page.locator('#leaseDetail a[data-radar-key="client"]')).toHaveAttribute('href', `/clients?record=${fixture.lease.client_id}`);
  await page.keyboard.press('Escape');
  await expect(page.locator('#leaseDetail')).toBeHidden();
}

async function acceptedRoute(request, fixture) {
  const response = await request.get(`/api/tours/detail?tour_id=${fixture.tour.id}`);
  expect(response.ok()).toBe(true);
  const { data } = await response.json();
  const route = data.routes.find(route => route.id === fixture.tour.route_id);
  expect(route?.accepted).toBe(true);
  expect(data.route_version_id).toBe(fixture.tour.route_id);
  expect(route.stops.map(stop => stop.property_id)).toEqual(fixture.tour.property_ids);
  expect(route.stops.map(stop => stop.id)).toEqual(fixture.tour.stop_ids);
  expect(route.stops.map(stop => stop.route_sequence)).toEqual([1, 2]);
  expect(route.stops.map(stop => stop.route_label)).toEqual(['A', 'B']);
  return route;
}

export async function tourDay(page, fixture) {
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
}

export async function itinerary(page, fixture) {
  const before = await acceptedRoute(page.request, fixture);
  await page.goto(`/tours/route-editor.html?tour=${fixture.tour.id}`);
  await expect(page.locator('#tour-name')).toHaveAttribute('title', fixture.tour.name, { timeout: 27000 });
  const stops = page.locator('#route-stops .composer-stop');
  await expect(stops).toHaveCount(2);
  expect(await stops.evaluateAll(nodes => nodes.map(node => node.dataset.propertyId))).toEqual(fixture.tour.property_ids);
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
}

export async function shareLifecycle(page, fixture) {
  await page.goto(`/tours/route-editor.html?tour=${fixture.tour.id}`);
  await expect(page.locator('#tour-name')).toHaveAttribute('title', fixture.tour.name, { timeout: 27000 });
  await page.locator('#receipt-digest').fill('sha256:' + 'b'.repeat(64));
  await page.locator('input[name="scope"][value="shortlist"]').check();
  const issue = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tours/share/issue');
  await page.locator('#share-form button[type="submit"]').click();
  expect((await issue).ok()).toBe(true);
  await expect(page.locator('#share-link')).toBeVisible();
  const link = await page.locator('#share-url').inputValue();
  await page.locator('#share-url').evaluate(node => { node.value = ''; });
  let issued;
  try { issued = new URL(link); } catch { throw new Error('Malformed confidential Share URL'); }
  expect(issued.pathname === '/share' && issued.search === '' && /^#token=[A-Za-z0-9_-]{43}$/.test(issued.hash),
    'confidential Share URL has the required shape').toBe(true);
  const client = await page.context().newPage();
  try {
    await client.goto(`/share${issued.hash}`).catch(() => {
      throw new Error('Share navigation failed; confidential URL omitted');
    });
    const [exchange] = await Promise.all([
      client.waitForResponse(response => new URL(response.url()).pathname === '/api/share/exchange'),
      client.locator('#open-tour').click(),
    ]);
    expect(exchange.ok()).toBe(true);
    await expect(client.locator('#report-list .report-item')).toHaveCount(2, { timeout: 27000 });
    await expect(client.locator('#report-list')).toContainText(fixture.tour.property_names[0]);
    await expect(client.locator('#report-list')).toContainText(fixture.tour.property_names[1]);
    const report = await client.request.get('/api/share/report');
    expect(report.ok()).toBe(true);
    const { data } = await report.json();
    expect(data.stops.map(stop => stop.name)).toEqual(fixture.tour.property_names);
    expect(JSON.stringify(data)).not.toContain(fixture.tour.unrelated_property_id);
    expect(JSON.stringify(data)).not.toContain('Synthetic Unrelated Office');
    const feedback = await client.request.get('/api/share/feedback');
    expect(feedback.ok()).toBe(true);
    const { data: feedbackData } = await feedback.json();
    const headers = { origin: new URL(client.url()).origin, 'sec-fetch-site': 'same-origin' };
    const allowed = await client.request.post('/api/share/shortlist', {
      headers, data: { projection_ref: feedbackData.projection_ref, property_ref: data.stops[0].property_ref,
        shortlisted: true, idempotency_key: randomUUID() },
    });
    expect(allowed.ok(), 'allowed-property shortlist write succeeds').toBe(true);
    expect((await allowed.json()).data.saved).toBe(true);
    const unrelatedRef = 'property:public:' + createHash('sha256')
      .update(`carr-internal:${fixture.tour.projection_id}:${fixture.tour.unrelated_property_id}`).digest('hex').slice(0, 32);
    const refused = await client.request.post('/api/share/shortlist', {
      headers,
      data: { projection_ref: feedbackData.projection_ref, property_ref: unrelatedRef,
        shortlisted: true, idempotency_key: randomUUID() },
    });
    expect(refused.status()).toBe(404);
    const revoke = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tours/share/revoke');
    await page.locator('#revoke-share').click();
    expect((await revoke).ok()).toBe(true);
    expect((await client.request.get('/api/share/report')).status()).toBe(404);
    const retry = await client.request.post('/api/share/exchange', {
      headers: { origin: new URL(client.url()).origin, 'sec-fetch-site': 'same-origin' }, data: { token: issued.hash.slice('#token='.length) },
    }).catch(() => { throw new Error('Share exchange failed; confidential request omitted'); });
    expect(retry.status()).toBe(404);
    await client.reload();
    await expect(client.locator('#report-list .report-item')).toHaveCount(0);
  } finally {
    await client.close();
  }
}
