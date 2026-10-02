import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createFixtureClient } from '../js/fixture-client.js';

const NOW = new Date('2026-10-01T15:00:00Z');
const leadRows = [96, 88, 71, 23].map((score, i) => ({ id: `demo-lead-${i}`, name: `Demo New Practice ${i + 1}`, specialty: 'Demo specialty', city: 'Demo City', score,
  owner: i === 0 ? 'dell' : 'joe', owner_label: 'Demo partner', stage: 'new', stage_label: 'New', created_at: NOW.toISOString() }));
const screenshot = async (page, name) => {
  if (!process.env.W2_SCREENSHOT_DIR) return;
  await mkdir(process.env.W2_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.W2_SCREENSHOT_DIR, `${name}.png`), fullPage: !name.includes('detail') });
};

async function open(t, { width = 1440, leads = true, delayDetails = false } = {}) {
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}` });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'UTC' });
  await page.clock.install({ time: NOW }); page.setDefaultTimeout(5000);
  const errors = [], calls = [], liveLeads = structuredClone(leadRows); let boardReads = 0, failBoard = false;
  page.on('pageerror', error => errors.push(error.message));
  const handlers = {
    'deal-room-board': async () => { boardReads++; if (failBoard) throw Error('Unavailable'); return client.getBoard(); },
    'get-deal-room': async args => { if (delayDetails) await new Promise(resolve => setTimeout(resolve, 100)); const detail = await client.getDeal(args.deal); return { ...detail,
      critical_dates: [{ id: `demo-date-${args.deal}`, label: 'Demo tour', due_on: '2026-10-03', status: 'open' }],
      next_actions: [{ id: `demo-task-${args.deal}`, description: 'Demo follow-up', due_on: '2026-10-01', status: 'open', owner: detail.deal.owner }] }; },
    'lead-board': async () => ({ leads: leads ? liveLeads : [] }),
    'incident-board': () => client.incidentBoard(), 'current-work-item': () => client.currentWorkItem(),
    'read-resource-dashboard': () => client.readResourceDashboard(), 'schedule-board': () => client.scheduleBoard(),
    'list-notifications': async () => ({ unread_count: 0, notifications: [] }),
    'notification-feed': async () => ({ unread_count: 0, notifications: [] }),
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/mcp') {
      const rpc = route.request().postDataJSON(); calls.push(rpc.params.name);
      try { return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(await (handlers[rpc.params.name]?.(rpc.params.arguments) ?? {})) }] } } }); }
      catch { return route.fulfill({ status: 503, json: { error: 'Unavailable' } }); }
    }
    if (url.pathname === '/api/system-work/current') return route.fulfill({ json: { ok: true, data: await client.currentWorkRequests() } });
    if (url.pathname === '/api/system-work/session') return route.fulfill({ json: { actor: { slug: 'joe', label: 'Demo partner' }, csrf_token: 'synthetic' } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ status: 503, json: {} });
    const file = url.pathname === '/' ? 'workspace.html' : url.pathname === '/deals' ? 'index.html' : url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(`../${file}`, import.meta.url)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/?mode=live');
  await page.waitForFunction(() => /Active Deals: \d/.test(document.querySelector('#dealCounts')?.textContent || ''));
  return { page, errors, calls, get boardReads() { return boardReads; }, failBoard(value) { failBoard = value; }, updateLead(id, score) { liveLeads.find(row => row.id === id).score = score; } };
}

test('Home desktop and phone show flags, visual agenda, ranked leads and wide entry detail with no overflow', async t => {
  for (const width of [1440, 390, 320]) await t.test(String(width), async t => {
    const { page, errors, calls } = await open(t, { width });
    await page.locator('#homeCalendar:not([hidden])').waitFor();
    await page.locator('#homeLeads:not([hidden])').waitFor();
    await page.locator('#homeControl:not([hidden])').waitFor();
    assert.equal(await page.locator('.home-week .home-day').count(), 7);
    assert.equal(await page.locator('.home-lead').count(), 3);
    assert.equal(await page.locator('.home-flags .home-flag').count(), 4);
    assert.match(await page.locator('#homeControl').textContent(), /Needs attention/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.match(await page.locator('#observedAt').textContent(), /^Updated /);
    const text = await page.locator('main').textContent();
    assert.doesNotMatch(text, /source|records read|read again|retry|Doc at work|Changed in 7 days|Workspace structure/i);
    assert.ok(calls.every(name => Object.keys({ 'deal-room-board': 1, 'get-deal-room': 1, 'lead-board': 1, 'incident-board': 1, 'current-work-item': 1, 'read-resource-dashboard': 1, 'schedule-board': 1, 'list-notifications': 1, 'notification-feed': 1 }).includes(name)), `no write verb runs: ${calls.join(', ')}`);
    await screenshot(page, width === 1440 ? 'desktop' : `phone-${width}`);
    const first = page.locator('.home-lead').first(); await first.click();
    assert.equal(await page.locator('#homeDetail').evaluate(dialog => dialog.open), true);
    assert.match(await page.locator('#homeDetailTitle').textContent(), /Demo New Practice 1/);
    const rect = await page.locator('#homeDetail').boundingBox();
    assert.ok(rect.width > (width === 1440 ? 900 : width - 40));
    assert.equal(await page.locator('#homeDetail details').getAttribute('open'), null);
    await page.locator('#homeDetail summary').click();
    assert.match(await page.locator('#homeDetail dd').first().textContent(), /10\/1\/2026/);
    await screenshot(page, width === 1440 ? 'desktop-detail' : `phone-detail-${width}`);
    await page.keyboard.press('Escape'); assert.equal(await first.evaluate(node => document.activeElement === node), true);
    await page.getByRole('button', { name: 'Just Me', exact: true }).click();
    assert.equal(await page.locator('.home-flags .home-flag').count(), 2);
    assert.match(await page.locator('.home-lead').first().textContent(), /Demo New Practice 2/);
    await page.getByRole('button', { name: 'Just Me', exact: true }).press('ArrowLeft');
    assert.equal(await page.getByRole('button', { name: 'Team View', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []);
  });
});

test('reduced motion stops ambient and hover motion without hiding data', async t => {
  const { page } = await open(t);
  await page.locator('.home-radar').waitFor();
  assert.ok(await page.locator('.radar-wave').evaluate(node => getComputedStyle(node).animationName !== 'none'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.radar-wave').evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.locator('.home-flag').first().hover();
  assert.equal(await page.locator('.home-flag').first().evaluate(node => getComputedStyle(node).transform), 'none');
  assert.equal(await page.locator('.home-day').count(), 7);
  assert.equal(await page.locator('.home-flag').count(), 4);
  await screenshot(page, 'desktop-reduced-motion');
});

test('no eligible leads means hidden widget; polling, resume and online recover failed Home without a retry prompt', async t => {
  const state = await open(t, { leads: false }); const { page } = state;
  assert.equal(await page.locator('#homeLeads').isVisible(), false);
  state.failBoard(true);
  await page.clock.fastForward(31_000);
  await page.waitForFunction(() => document.querySelector('#dealCounts').textContent.includes('Active Deals: —'));
  assert.equal(await page.locator('#homeCalendar').isVisible(), false);
  assert.doesNotMatch(await page.locator('main').textContent(), /retry|read again/i);
  state.failBoard(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => /Active Deals: \d/.test(document.querySelector('#dealCounts').textContent));
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  const before = state.boardReads;
  const resumed = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postDataJSON()?.params.name === 'deal-room-board');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForFunction(() => /Active Deals: \d/.test(document.querySelector('#dealCounts').textContent));
  await resumed; assert.ok(state.boardReads > before);
  assert.deepEqual(state.errors, []);
});

test('a flagged Home deal opens that exact Deals record; unknown IDs do not open another deal', async t => {
  const { page, errors } = await open(t);
  const href = await page.locator('.home-flag').first().getAttribute('href');
  assert.equal(href, '/deals?deal=d01');
  // Keep this synthetic test on the fixture adapter on the receiving page.
  await page.locator('.home-flag').first().click();
  await page.waitForFunction(() => document.querySelector('#dealDialog')?.open).catch(error => { throw new Error(`${error.message} ${errors.join('; ')}`); });
  assert.equal(await page.locator('#dealDialog').getAttribute('data-deal-id'), 'd01');
  assert.match(await page.locator('#dealDetail h2').textContent(), /Demo Dental North/);
  await page.goto('http://localhost/deals?deal=unknown');
  await page.locator('#rows .deal-link').first().waitFor();
  assert.equal(await page.locator('#dealDialog').evaluate(dialog => dialog.open), false);
});

test('an open lead detail updates automatically while preserving expanded Details and focus', async t => {
  const state = await open(t); const { page } = state;
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  await page.locator('.home-lead').first().click();
  await page.locator('#homeDetail summary').click();
  state.updateLead('demo-lead-0', 97);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('.home-detail-score')?.textContent.includes('97'));
  assert.equal(await page.locator('#homeDetail details').evaluate(node => node.open), true);
  assert.equal(await page.locator('#homeDetail summary').evaluate(node => document.activeElement === node), true);
  assert.deepEqual(state.errors, []);
});
