import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const clientId = '11111111-1111-4111-8111-111111111111';
const tourId = '22222222-2222-4222-8222-222222222222';
const client = { id: clientId, name: 'Demo Harbor Practice', city: 'Pensacola', state: 'FL', vertical: 'Medical office', notes: 'Synthetic call entry: ground-floor space and patient parking.' };
const tour = { id: tourId, name: 'Demo Gulf Coast Tour', status: 'draft', stops: [{ property_name: 'Demo Bayside Office', property_address: '100 Example Way', stop_state: 'active' }], cheat_sheet: { content: { notes: 'Synthetic cheat sheet.' } } };

function tourData(url: URL) {
  if (url.pathname === '/api/tours/library') return { tours: [{ id: tourId, name: tour.name, status: 'draft' }] };
  if (url.pathname === '/api/tours/detail') return tour;
  if (url.pathname === '/api/v1/business/clients') return { rows: [client], page: 1, page_count: 1 };
  if (url.pathname === `/api/v1/business/clients/${clientId}`) return { record: client };
  return {};
}

// W6: the tour planner prefills from a client, undoes an edit, and keeps its
// drafts in this tab across a reload.
test('W6 Tours drafts prefill from a client, undo an edit and survive a reload', { video: 'on', trace: 'on' }, async ({ app, browser, screen }) => {
  await browser.route(/\/api\/(tours|v1\/business)\//, route =>
    route.fulfill({ json: { data: tourData(new URL(route.request.url)), csrf_token: 'synthetic-e2e-token' } }));
  await app.open('/tours');

  await browser.locator('#plan-client').selectOption('Demo Harbor Practice');
  await expect(browser.locator('#plan-name')).toHaveValue(/Demo Harbor/);
  await expect(browser.locator('#plan-area')).toHaveValue('Pensacola, FL');
  await browser.locator('#plan-area').fill('Typed tour area');
  await screen.getByLabel('Undo tour edit', { exact: true }).tap();
  await expect(browser.locator('#plan-area')).toHaveValue('Pensacola, FL');
  await browser.locator('#plan-date').fill('2026-10-08');

  await browser.locator('[data-market="Pensacola, FL"]').tap();
  await expect(browser.locator('#space-area')).toHaveValue('Pensacola, FL');
  await browser.locator('#space-minSize').fill('1800');
  await browser.locator('#space-requirements').fill('Ground floor · accessible entry');
  await browser.locator('#save-search').tap();
  await expect(browser.locator('#space-message')).toContainText('saved');

  await browser.reload();
  await expect(browser.locator('#plan-name')).toHaveValue(/Demo Harbor/);
  await expect(browser.locator('#plan-date')).toHaveValue('2026-10-08');
  await expect(browser.locator('#space-requirements')).toHaveValue('Ground floor · accessible entry');

  await browser.locator('#upcoming-tours .tour-button').first().tap();
  await expect(browser.locator('#detail-title')).toContainText('Demo Gulf Coast Tour');
  await browser.keyboard.press('Escape');
  await expect(browser.locator('#tour-dialog')).toBeHidden();
});
