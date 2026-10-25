import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { detail, tourId } from './fixtures/tour-day.synthetic.mjs';

async function open(t, width) {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === '/api/tours/library' ? { data: { tours: [{ id: tourId, name: 'Synthetic morning tour', status: 'scheduled' }] } }
      : path === '/api/tours/detail' ? { data: detail }
      : path === '/api/v1/business/clients' ? { data: { rows: [], page: 1, page_count: 1 } }
      : ['/api/system-work/session', '/auth/session'].includes(path) ? { actor: { slug: 'joe' }, csrf_token: 'synthetic-only' } : {} });
  });
  await page.goto(`${server.origin}/tours`);
  await page.locator('body.has-app-layout').waitFor();
  return page;
}

for (const width of [320, 390]) test(`phone destinations have readable labels and keyboard access at ${width}px`, async t => {
  const page = await open(t, width);
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  for (const label of ['Home', 'Leads', 'Deals', 'Tours', 'More']) {
    const text = nav.getByText(label, { exact: true });
    assert.equal(await text.count(), 1, `${label} is present`);
    const box = await text.boundingBox();
    assert.ok(box && box.width > 10 && box.height > 10, `${label} is visually readable`);
  }
  const controls = nav.locator(':scope > a, .app-shell-more-toggle');
  assert.equal(await controls.count(), 5);
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, 'navigation target is at least 44px');
    assert.ok(box.x >= 0 && box.x + box.width <= width, 'navigation stays within the phone');
  }
  await nav.getByRole('link', { name: 'Home', exact: true }).focus();
  for (const name of ['Leads', 'Local Deals', 'Tours', 'More']) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), name);
  }
  await page.keyboard.press('Enter');
  assert.equal(await nav.getByRole('link', { name: 'Vendors', exact: true }).isVisible(), true);
  assert.equal(await nav.getByRole('link', { name: 'Control Room', exact: true }).isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await nav.getByRole('button', { name: 'More', exact: true }).getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'selfAvatar');
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button', { name: 'Profile', exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('phone main view opens an existing Tour day and the full library by name', async t => {
  const page = await open(t, 390);
  const entry = page.getByRole('region', { name: 'Your tours', exact: true });
  assert.equal(await entry.count(), 1, 'Your tours is a named main-view entry');
  assert.equal(await entry.getByText('Synthetic morning tour', { exact: true }).isVisible(), true);
  const day = entry.getByRole('link', { name: 'Tour day', exact: true });
  const box = await day.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height < 650, 'Tour day is on the first phone screen');
  assert.ok(box.width >= 44 && box.height >= 44);
  const [opened] = await Promise.all([page.waitForEvent('popup'), day.click()]);
  await opened.waitForLoadState();
  assert.equal(new URL(opened.url()).searchParams.get('tour'), tourId);
  assert.equal(new URL(opened.url()).pathname, '/tours/day.html');
  await opened.close();
  await entry.getByRole('button', { name: 'Browse your tours', exact: true }).click();
  const library = page.locator('#appSidebar');
  assert.equal(await library.getByRole('heading', { name: 'Your tours', exact: true }).isVisible(), true);
  assert.equal(await library.getByRole('button', { name: /Synthetic morning tour/ }).isVisible(), true);
});
