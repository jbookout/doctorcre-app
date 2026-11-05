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

test('W6 Tours lists saved tours and keeps planning inside deal workspaces', async ({ app, browser }) => {
  await browser.route(/\/api\/(tours|v1\/business)\//, route =>
    route.fulfill({ json: { data: tourData(new URL(route.request.url)), csrf_token: 'synthetic-e2e-token' } }));
  await app.open('/tours');
  await expect(browser.locator('#plan-form, #create-tour-form')).toHaveCount(0);
  await browser.locator('#upcoming-tours .tour-button').first().tap();
  await expect(browser.locator('#detail-title')).toContainText('Demo Gulf Coast Tour');
  await expect(browser.locator('#detail-content a')).toHaveAttribute('href', /route-editor\.html\?tour=/);
});
