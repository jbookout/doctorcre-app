import { createHash, randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

test('Share without a confidential link reveals no properties or feedback controls', async ({ page }) => {
  await page.goto('/share');
  await expect(page.locator('#status')).not.toBeEmpty({ timeout: 27000 });
  await expect(page.locator('#report-list li')).toHaveCount(0);
  await expect(page.locator('#open-tour')).toBeDisabled();
});

test('A confidential Share issues, exchanges and revokes without exposing unrelated properties', async ({ page }) => {
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
  expect(fixture.tour.unrelated_property_id, 'E2E_UNRELATED_PROPERTY_ID must name a synthetic property outside this tour').toMatch(/^[0-9a-f-]{36}$/);
  expect(fixture.tour.property_ids).not.toContain(fixture.tour.unrelated_property_id);
  await page.goto(`/tours/route-editor.html?tour=${fixture.tour.id}`);
  await expect(page.locator('#tour-name')).toHaveAttribute('title', fixture.tour.name, { timeout: 27000 });
  await page.locator('.projection-card > summary').click();
  await page.locator('#receipt-digest').fill('sha256:' + 'b'.repeat(64));
  await page.locator('input[name="scope"][value="shortlist"]').check();
  const issue = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tours/share/issue');
  await page.locator('#share-form button[type="submit"]').click();
  expect((await issue).ok()).toBe(true);
  await expect(page.locator('#share-link')).toBeVisible();
  const link = await page.locator('#share-url').inputValue();
  await page.locator('#share-url').evaluate((node: HTMLInputElement) => { node.value = ''; });
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
    expect(data.stops.map((stop: { name: string }) => stop.name)).toEqual(fixture.tour.property_names);
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
    if (await page.locator('#revoke-share').isEnabled()) {
      const revoke = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tours/share/revoke');
      await page.locator('#revoke-share').click();
      expect((await revoke).ok()).toBe(true);
    }
    await client.close();
  }
});
