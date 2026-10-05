import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from './browser-harness.mjs';
import { createFixtureClient } from '../js/fixture-client.js';
import { leaseRadarFixture } from '../js/lease-radar-fixture.js';
import { invoiceTrackerFixture } from '../js/invoice-tracker-fixture.js';

const NOW = new Date('2026-10-01T18:00:00Z');
async function shot(page, name) {
  if (!process.env.W13_SCREENSHOT_DIR) return;
  await mkdir(process.env.W13_SCREENSHOT_DIR, { recursive: true });
  await page.clock.runFor(300);
  await page.screenshot({ path: join(process.env.W13_SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
}
async function open(t, { width = 1440, home = false, long = false, motion = 'reduce' } = {}) {
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}` });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'America/Chicago', reducedMotion: motion });
  await page.clock.install({ time: NOW });
  const payload = leaseRadarFixture('2026-10-01'), errors = [], calls = [];
  let failure = null, reads = 0;
  if (long) payload.leases[0].client_name = `Demo${'Practice'.repeat(30)}`;
  page.on('pageerror', error => errors.push(error.message));
  const handlers = {
    'morning-brief': async () => ({ state:'unavailable' }),
    'deal-room-board': () => client.getBoard(), 'get-deal-room': args => client.getDeal(args.deal),
    'lead-board': async () => ({ leads: [] }), 'incident-board': () => client.incidentBoard(),
    'current-work-item': () => client.currentWorkItem(), 'read-resource-dashboard': () => client.readResourceDashboard(),
    'schedule-board': () => client.scheduleBoard(), 'list-notifications': async () => ({ unread_count: 0, notifications: [] }),
    'notification-feed': async () => ({ unread_count: 0, notifications: [] }), 'today-triage': async () => ({ items: [] }),
    'read-invoice-tracker': async () => invoiceTrackerFixture('2026-10-01'),
    'list-feature-switches': () => client.listFeatureSwitches(),
    'list-doc-suggestions': args => client.listDocSuggestions(args),
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost')
      return route.abort();
    if (url.pathname === '/api/v1/business/leases') {
      reads++; assert.equal(route.request().method(), 'GET');
      if (failure === 'timeout') return;
      return route.fulfill({ status: failure || 200, json: failure ? {} : payload });
    }
    if (url.pathname === '/mcp') {
      const rpc = route.request().postDataJSON(); calls.push(rpc.params.name);
      assert.ok(handlers[rpc.params.name], `unexpected verb: ${rpc.params.name}`);
      return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(await handlers[rpc.params.name](rpc.params.arguments)) }] } } });
    }
    if (url.pathname === '/api/system-work/current') return route.fulfill({ json: { ok: true, data: await client.currentWorkRequests() } });
    if (url.pathname === '/pipeline/changes') return route.fulfill({ json: { changes: [], cursor: null } });
    if (url.pathname === '/api/system-work/session') return route.fulfill({ json: { actor: { slug: 'joe', label: 'Demo partner' }, csrf_token: 'synthetic' } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ status: 503, json: {} });
    const file = url.pathname === '/' ? 'workspace.html' : url.pathname === '/leases' ? 'lease-radar.html' : url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(`../${file}`, import.meta.url)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`http://localhost/${home ? '' : 'leases'}?mode=live`);
  await page.locator(home ? '#homePastClients .lease-card' : '#leaseRadar .lease-card').first().waitFor();
  return { page, errors, calls, payload, fail(value) { failure = value; }, get reads() { return reads; } };
}
const settled = page => page.waitForFunction(() => document.querySelector('#refreshLeases').getAttribute('aria-busy') === 'false');
const online = page => page.evaluate(() => window.dispatchEvent(new Event('online')));

test('finding 4: malformed Home touch read clears cards and open details', async t => {
  const state = await open(t, {home:true}); const {page} = state;
  await page.locator('#homePastClients .lease-card').first().click();
  state.payload.leases[0].touch_id = 42;
  await online(page);
  await page.getByText('Follow-ups unavailable',{exact:true}).waitFor();
  assert.equal(await page.locator('#homePastClients .lease-card').count(),0);
  assert.equal(await page.locator('#pastLeaseDetail').evaluate(n=>n.open),false);
  assert.deepEqual(state.errors,[]);
});
test('finding 4: Home projection exceptions enter unavailable and recover', async t => {
  const {page,errors} = await open(t,{home:true});
  await page.locator('#homePastClients .lease-card').first().click();
  await page.evaluate(() => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = function (...args) {
      if (String(this).startsWith('demo-touch-')) throw Error('Synthetic projection failure');
      return original.apply(this,args);
    };
    window.restoreCompare = () => {String.prototype.localeCompare = original;};
  });
  await online(page); await page.getByText('Follow-ups unavailable',{exact:true}).waitFor();
  assert.equal(await page.locator('#pastLeaseDetail').evaluate(n=>n.open),false);
  await page.evaluate(()=>window.restoreCompare()); await online(page);
  await page.locator('#homePastClients .lease-card').first().waitFor();
  assert.deepEqual(errors,[]);
});

test('radar uses shared slots, quarter timeline, wide details and gaps at desktop and phone widths', async t => {
  for (const width of [1440, 390, 320]) await t.test(String(width), async t => {
    const { page, errors } = await open(t, { width });
    assert.equal(await page.locator('#appTabsSlot [data-lease-view]').count(), 2);
    assert.equal(await page.locator('#appSidebarSlot #leaseSearch').count(), 1);
    assert.equal(await page.locator('#leaseRadar .lease-card').count(), 9);
    assert.equal(await page.locator('.lease-quarter-mark').count(), 9);
    const chart = await page.locator('.lease-timeline-chart').evaluate(n => ({scale:n.getBoundingClientRect().width/n.viewBox.baseVal.width,font:parseFloat(getComputedStyle(n.querySelector('text')).fontSize),hit:n.querySelector('.lease-quarter-hit').getBoundingClientRect().width}));
    assert.ok(chart.scale * chart.font >= 12, 'quarter labels remain readable');
    assert.ok(chart.hit >= 44, 'quarter targets fit touch');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.doesNotMatch(await page.locator('main').textContent(), /source|records read|read again|retry/i);
    await shot(page, `timeline-${width}`);
    const card = page.locator('[data-lease="demo-lease-1"]'); await card.click();
    assert.match(await page.locator('#leaseDetailTitle').textContent(), /Demo Practice 1/);
    assert.ok((await page.locator('#leaseDetail').boundingBox()).width > (width === 1440 ? 900 : width - 40));
    assert.equal(await page.locator('#leaseDetail details').evaluate(n => n.open), false);
    await page.locator('#leaseDetail summary').click();
    assert.match(await page.locator('#leaseDetail .lease-original').first().textContent(), /Demo entry/);
    assert.equal(await page.locator('#leaseDetail').evaluate(n => n.scrollWidth <= n.clientWidth), true);
    await shot(page, `detail-${width}`);
    await page.keyboard.press('Escape'); assert.equal(await card.evaluate(n => document.activeElement === n), true);
    await page.locator('[data-lease-view="gaps"]').click();
    assert.equal(await page.locator('#leaseRadar .lease-card').count(), 2);
    await shot(page, `gaps-${width}`);
    await page.locator('[data-lease="demo-lease-9"]').click();
    assert.match(await page.locator('#leaseDetail').textContent(), /Missing expiry.*Needs review/s);
    assert.deepEqual(errors, []);
  });
});
test('quarter keyboard interaction, search and owner filtering retain the correct leases', async t => {
  const { page } = await open(t);
  const quarter = page.locator('[data-quarter="2026-Q4"]'); await quarter.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#leaseRadar .lease-card').count(), 1);
  await page.keyboard.press('Space'); assert.equal(await page.locator('#leaseRadar .lease-card').count(), 9);
  await page.locator('#leaseSearch').fill('Practice 2'); assert.equal(await page.locator('#leaseRadar .lease-card').count(), 1);
  await page.locator('#leaseSearch').fill(''); await page.locator('#leaseScope').selectOption('mine');
  assert.equal(await page.locator('#leaseRadar .lease-card').count(), 5);
});
test('polling updates an open detail and preserves focus, while refusals clear stale cards and recover', async t => {
  const state = await open(t); const { page } = state; await settled(page);
  await page.locator('[data-lease="demo-lease-1"]').click(); await page.locator('#leaseDetail summary').click();
  state.payload.leases[0].touch_summary = 'Demo updated plans'; await online(page); await settled(page);
  assert.match(await page.locator('#leaseDetail').textContent(), /Demo updated plans/);
  assert.equal(await page.locator('#leaseDetail details').evaluate(n => n.open), true);
  assert.equal(await page.locator('#leaseDetail summary').evaluate(n => document.activeElement === n), true);
  state.payload.leases[0].client_name = 'Demo Updated Practice'; await online(page); await settled(page);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.dataset.radarKey === 'lease:demo-lease-1');
  assert.equal(await page.locator('[data-lease="demo-lease-1"]').evaluate(n => document.activeElement === n), true);
  await page.locator('[data-lease="demo-lease-1"]').click();
  const before = state.reads; await page.clock.runFor(31_000); await settled(page); assert.ok(state.reads > before);
  state.fail(503); await online(page); await settled(page);
  assert.equal(await page.locator('#leaseRadar .lease-card').count(), 0);
  assert.equal(await page.locator('#leaseDetail').evaluate(n => n.open), false);
  state.fail(null); await page.clock.runFor(31_000); await settled(page);
  assert.equal(await page.locator('#leaseRadar .lease-card').count(), 9);
  state.fail(403); await online(page); await settled(page);
  assert.equal(await page.getByRole('link', { name: 'Sign in', exact: true }).isVisible(), true);
  assert.deepEqual(state.errors, []);
});
test('timeout clears stale details and automatically recovers', async t => {
  const state = await open(t); const { page } = state; await settled(page);
  await page.locator('[data-lease="demo-lease-1"]').click(); state.fail('timeout'); await online(page);
  await page.clock.runFor(10_001); await settled(page);
  assert.equal(await page.locator('#leaseDetail').evaluate(n => n.open), false);
  assert.equal(await page.locator('#leaseRadar .lease-card').count(), 0);
  state.fail(null); await page.clock.runFor(31_000); await settled(page);
  assert.equal(await page.locator('#leaseRadar .lease-card').count(), 9);
});
test('reduced motion stops urgency and hover motion without hiding leases', async t => {
  const { page } = await open(t, { motion: 'no-preference' });
  assert.notEqual(await page.locator('.lease-light').first().evaluate(n => getComputedStyle(n).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.lease-light').first().evaluate(n => getComputedStyle(n).animationName), 'none');
  await page.locator('.lease-card').first().hover();
  assert.equal(await page.locator('.lease-card').first().evaluate(n => getComputedStyle(n).transform), 'none');
  assert.equal(await page.locator('.lease-card').count(), 9); await shot(page, 'reduced-motion');
});
test('Home shows next eligible past-client touches, opens lease details and refreshes eligibility', async t => {
  const state = await open(t, { home: true }); const { page } = state;
  assert.equal(await page.locator('#homePastClients .lease-card').count(), 4);
  assert.match(await page.locator('#homePastClients .lease-updated').textContent(), /Updated /);
  const before = state.reads;
  await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/v1/business/leases')), page.getByRole('button', { name: 'Refresh past-client touches' }).click()]);
  assert.ok(state.reads > before);
  assert.doesNotMatch(await page.locator('#homePastClients').textContent(), /Demo Practice 11/);
  await page.locator('#homePastClients').scrollIntoViewIfNeeded(); await shot(page, 'home-desktop'); await page.locator('#homePastClients .lease-card').first().click();
  assert.match(await page.locator('#pastLeaseDetailTitle').textContent(), /Demo Practice 1/);
  await page.keyboard.press('Escape'); state.payload.leases[0].touch_eligible = false; await online(page);
  await page.waitForFunction(() => !document.querySelector('#homePastClients').textContent.includes('Demo Practice 1'));
  await page.getByRole('button', { name: 'Just Me', exact: true }).click();
  assert.equal(await page.locator('#homePastClients .lease-card').count(), 4);
  state.fail(503); await page.clock.runFor(31_000);
  await page.getByText('Follow-ups unavailable', { exact: true }).waitFor();
  state.fail(null); await page.clock.runFor(31_000); await page.locator('#homePastClients .lease-card').first().waitFor();
  assert.deepEqual(state.errors, []);
});
test('long client names wrap within phone cards and lease detail', async t => {
  const { page } = await open(t, { width: 320, long: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('[data-lease="demo-lease-1"]').click();
  assert.equal(await page.locator('#leaseDetail').evaluate(n => n.scrollWidth <= n.clientWidth), true);
  await shot(page, 'phone-long-detail');
});
test('past-client touches and their detail fit phone width', async t => {
  const { page, errors } = await open(t, { width: 390, home: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#homePastClients').scrollIntoViewIfNeeded(); await shot(page, 'home-phone');
  await page.locator('#homePastClients .lease-card').first().click();
  assert.equal(await page.locator('#pastLeaseDetail').evaluate(n => n.scrollWidth <= n.clientWidth), true);
  await shot(page, 'home-phone-detail');
  assert.deepEqual(errors, []);
});
test('Home rejects a previous-day lease horizon and closes its outdated detail', async t => {
  const state = await open(t, { home: true }); const { page } = state;
  await page.locator('#homePastClients .lease-card').first().click();
  state.payload.window = { starts_on: '2026-09-30', ends_on: '2028-09-30' }; state.payload.leases = [];
  await online(page); await page.getByText('Follow-ups unavailable', { exact: true }).waitFor();
  assert.equal(await page.locator('#pastLeaseDetail').evaluate(n => n.open), false);
  assert.equal(await page.locator('#homePastClients .lease-card').count(), 0);
});
