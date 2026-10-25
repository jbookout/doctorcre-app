import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { detail, tourId } from './fixtures/tour-day.synthetic.mjs';

async function open(t, width, tours = [{ id: tourId, name: 'Synthetic morning tour', status: 'scheduled' }], tourDetail = detail) {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === '/api/tours/library' ? { data: { tours } }
      : path === '/api/tours/detail' ? { data: tourDetail }
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
  await page.keyboard.press('Escape');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
  const account = await page.locator('#selfAvatar').boundingBox();
  assert.ok(account.y + account.height <= 844 - 34, 'account clears the bottom safe area');
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    assert.ok(box.y + box.height <= 844 - 34, 'navigation clears the bottom safe area');
  }
  await mkdir('out/test-artifacts/phone-destinations', { recursive: true });
  await page.screenshot({ path: `out/test-artifacts/phone-destinations/tours-${width}.png` });
});

test('phone main view opens an existing Tour day and the full library by name', async t => {
  const page = await open(t, 390);
  const entry = page.getByRole('region', { name: 'Your tours', exact: true });
  assert.equal(await entry.count(), 1, 'Your tours is a named main-view entry');
  await entry.getByText('Synthetic morning tour', { exact: true }).waitFor();
  const day = entry.getByRole('link', { name: 'Tour day', exact: true });
  await day.waitFor();
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

test('phone draft tour stays browsable without offering Tour day', async t => {
  const page = await open(t, 390, [{ id: tourId, name: 'Synthetic draft tour', status: 'draft' }],
    { id: tourId, name: 'Synthetic draft tour', status: 'draft', stops: [], routes: [] });
  const entry = page.getByRole('region', { name: 'Your tours', exact: true });
  await entry.getByText('Synthetic draft tour', { exact: true }).waitFor();
  await entry.getByRole('button', { name: 'Browse your tours', exact: true }).click();
  await page.getByRole('button', { name: /Synthetic draft tour/ }).click();
  await page.locator('#detail-title').getByText('Synthetic draft tour', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  assert.equal(await entry.getByRole('link', { name: 'Tour day', exact: true }).isVisible(), false);
});

test('phone tour entry does not offer Tour day without an upcoming tour', async t => {
  const page = await open(t, 390, []);
  const entry = page.getByRole('region', { name: 'Your tours', exact: true });
  await entry.getByText('No upcoming tours', { exact: true }).waitFor();
  assert.equal(await entry.getByText('Tour day', { exact: true }).isVisible(), false);
  assert.equal(await entry.getByRole('button', { name: 'Browse your tours', exact: true }).isVisible(), true);
});

test('phone destinations reflow at the CSS viewport for 200 percent zoom', async t => {
  const page = await open(t, 780);
  await page.setViewportSize({ width: 390, height: 422 });
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  for (const label of ['Home', 'Leads', 'Deals', 'Tours', 'More']) {
    const box = await nav.getByText(label, { exact: true }).boundingBox();
    assert.ok(box.height > 10 && box.x >= 0 && box.x + box.width <= 390, `${label} is readable after reflow`);
  }
  const entry = page.getByRole('region', { name: 'Your tours', exact: true });
  await entry.getByText('Synthetic morning tour', { exact: true }).waitFor();
  await entry.getByRole('link', { name: 'Tour day', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});
