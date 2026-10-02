import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { relationshipNetworkFixture } from '../js/relationship-network-fixture.js';
import { createFixtureClient } from '../js/fixture-client.js';

const NOW = new Date('2026-10-01T15:00:00Z');
const { routes } = JSON.parse(await readFile(new URL('../contracts/app-routes.v1.json', import.meta.url), 'utf8'));
const leadRows = [96, 88, 71, 23].map((score, i) => ({ id: `demo-lead-${i}`, name: `Demo New Practice ${i + 1}`, specialty: 'Demo specialty', city: 'Demo City', score,
  owner: i === 0 ? 'dell' : 'joe', owner_label: 'Demo partner', stage: 'new', stage_label: 'New', created_at: NOW.toISOString() }));
const screenshot = async (page, name) => {
  if (!process.env.W2_SCREENSHOT_DIR) return;
  await mkdir(process.env.W2_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.W2_SCREENSHOT_DIR, `${name}.png`), fullPage: !name.includes('detail') });
};

async function open(t, { width = 1440, motion = 'reduce', leads = true, delayDetails = false, hangDetails = false, longLead = false, tasksOnly = false, malformedTasks = false, delayBoard = false, delayInitialFeed = false, origin = 'http://localhost', malformedBoard = false } = {}) {
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}` });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'UTC', reducedMotion: motion });
  // Virtual time pauses CSS transitions. Data journeys use reduced motion so
  // actionability cannot wait on a hover transition the clock never advances.
  await page.clock.install({ time: NOW }); page.setDefaultTimeout(5000);
  const errors = [], calls = [], liveLeads = structuredClone(leadRows); let boardReads = 0, feedReads = 0, failBoard = false, detailFailure = null, leadFailure = null;
  let boardMalformed = malformedBoard;
  let releaseInitialFeed;
  const initialFeed = new Promise(resolve => { releaseInitialFeed = resolve; });
  t.after(async () => {
    releaseInitialFeed();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await browser.close();
  });
  if (longLead) Object.assign(liveLeads[0], { name: `Demo${'Practice'.repeat(16)}`, specialty: 'DemoSpecialtyName', city: `Demo${'City'.repeat(20)}`, owner_label: `Demo${'Partner'.repeat(16)}`, stage_label: `Demo${'Stage'.repeat(20)}` });
  page.on('pageerror', error => errors.push(error.message));
  const handlers = {
    'deal-room-board': async () => { boardReads++; if (delayBoard) await new Promise(resolve => setTimeout(resolve, 100)); if (failBoard) throw Error('Unavailable'); const board = await client.getBoard(); if (boardMalformed) return { ...board, deals: [{ name: 'Demo missing record identity' }] }; return hangDetails ? { ...board, deals: Array.from({ length: 12 }, (_, i) => ({ ...board.deals[0], id: `demo-${i}`, operating_state: 'active' })) } : board; },
    'get-deal-room': async args => { if (detailFailure === '503') throw Error('Unavailable'); if (hangDetails || detailFailure === 'timeout') return new Promise(() => {}); if (delayDetails) await new Promise(resolve => setTimeout(resolve, 100)); const detail = await client.getDeal(args.deal); return { ...detail,
      ...detail.deal, deal_id: detail.deal.id, events: detail.history.map(event => ({ ...event, verb: event.verb || 'patch-deal-field' })),
      critical_dates: tasksOnly ? [] : [{ id: `demo-date-${args.deal}`, note: 'Demo tour', due_on: '2026-10-03', status: 'open' }],
      next_actions: malformedTasks ? [null] : [{ id: `demo-task-${args.deal}`, description: 'Demo follow-up', due_on: '2026-10-01', status: 'open', owner: detail.deal.owner }] }; },
    'lead-board': async () => { if (leadFailure === 'timeout') return new Promise(() => {}); if (leadFailure) { const error = Error('Refused'); error.status = leadFailure; throw error; } return { leads: leads ? liveLeads : [] }; },
    'incident-board': () => client.incidentBoard(), 'current-work-item': () => client.currentWorkItem(),
    'read-resource-dashboard': () => client.readResourceDashboard(), 'schedule-board': () => client.scheduleBoard(),
    'list-notifications': async () => ({ unread_count: 0, notifications: [] }),
    'notification-feed': async () => ({ unread_count: 0, notifications: [] }),
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/mcp') {
      const rpc = route.request().postDataJSON(); calls.push(rpc.params.name);
      try { return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(await (handlers[rpc.params.name]?.(rpc.params.arguments) ?? {})) }] } } }); }
      catch (error) { return route.fulfill({ status: error.status || 503, json: { error: 'Unavailable' } }); }
    }
    if (url.pathname === '/api/v1/business/relationships') return route.fulfill({ json: relationshipNetworkFixture(await page.evaluate(() => new Date().toISOString())) });
    if (url.pathname === '/api/system-work/current') return route.fulfill({ json: { ok: true, data: await client.currentWorkRequests() } });
    if (url.pathname === '/pipeline/changes') {
      feedReads++;
      if (delayInitialFeed && feedReads === 1) await initialFeed;
      return route.fulfill({ json: { changes: [], cursor: null } });
    }
    if (url.pathname === '/api/system-work/session') return route.fulfill({ json: { actor: { slug: 'joe', label: 'Demo partner' }, csrf_token: 'synthetic' } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ status: 503, json: {} });
    if (tasksOnly && url.pathname === '/js/fixture-client.js') {
      let source = await readFile(new URL('../js/fixture-client.js', import.meta.url), 'utf8');
      source = source.replace('export async function createFixtureClient', 'async function originalFixtureClient');
      source += `\nexport async function createFixtureClient(options) { const client = await originalFixtureClient(options); const read = client.getDeal; client.getDeal = async id => ({ ...await read(id), critical_dates: [], next_actions: [{ id: 'demo-task-' + id, description: 'Demo follow-up', status: 'open', due_on: '2026-10-01', owner: 'joe' }] }); return client; }`;
      return route.fulfill({ body: source, contentType: 'text/javascript' });
    }
    const file = url.pathname === '/deals' && url.searchParams.get('view') === 'national' ? 'index.html' : routes[url.pathname] || url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(`../${file}`, import.meta.url)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`${origin}/?mode=live`);
  await page.waitForFunction(() => /Active Deals: \d/.test(document.querySelector('#dealCounts')?.textContent || '') || /unavailable/i.test(document.querySelector('#observedAt')?.textContent || ''));
  return { page, errors, calls, releaseInitialFeed, get boardReads() { return boardReads; }, get feedReads() { return feedReads; }, malformBoard(value) { boardMalformed = value; }, failLeads(value) { leadFailure = value; }, failDetails(value) { detailFailure = value; }, failBoard(value) { failBoard = value; }, updateLead(id, score) { liveLeads.find(row => row.id === id).score = score; } };
}

test('PR124 R1 generated Home flag and task links open the requested record through the deployed route', async t => {
  const { page, errors } = await open(t, { origin: 'https://app.doctorcre.com' });
  for (const selector of ['.home-flag', '.home-agenda a:has(.home-item-type:text-is("Task"))']) {
    await page.locator(selector).first().waitFor();
    const link = page.locator(selector).first();
    const id = new URL(await link.getAttribute('href'), page.url()).searchParams.get('deal');
    assert.ok(id);
    await link.click();
    await page.locator('.kanban-card').first().waitFor();
    await page.waitForFunction(id => document.querySelector('#recordPanel')?.open && document.querySelector('#detailNextForm') && document.querySelector('#detailOwner'), id);
    const detail = await page.evaluate(async () => (await import('/js/pipeline.js')).state.panelDetail);
    assert.equal(detail.deal.id, id);
    assert.equal(await page.locator('#panelTitle').textContent(), detail.deal.name);
    await page.keyboard.press('Escape');
    await page.goto('https://app.doctorcre.com/');
  }
  assert.deepEqual(errors, []);
});

test('PR124 R2 malformed initial or refreshed Home board shows unavailable counts and recovers', async t => {
  const state = await open(t, { malformedBoard: true }); const { page } = state;
  const settled = () => page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  const unavailable = async () => {
    await settled();
    assert.match(await page.locator('#dealFlags').textContent(), /Deals unavailable/);
    assert.doesNotMatch(await page.locator('#dealCounts').textContent(), /:\s*0/);
    assert.match(await page.locator('#observedAt').textContent(), /Unavailable/);
    assert.equal(await page.locator('#homeNotice').isVisible(), true);
  };
  await unavailable();
  state.malformBoard(false);
  await page.evaluate(() => dispatchEvent(new Event('online'))); await settled();
  assert.match(await page.locator('#dealCounts').textContent(), /Active Deals: [1-9]/);
  assert.equal(await page.locator('#homeNotice').isVisible(), false);
  state.malformBoard(true);
  await page.evaluate(() => dispatchEvent(new Event('online'))); await unavailable();
  assert.deepEqual(state.errors, []);
});

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
    assert.ok(calls.every(name => Object.keys({ 'today-triage': 1, 'deal-room-board': 1, 'get-deal-room': 1, 'lead-board': 1, 'incident-board': 1, 'current-work-item': 1, 'read-resource-dashboard': 1, 'schedule-board': 1, 'list-notifications': 1, 'notification-feed': 1 }).includes(name)), `no write verb runs: ${calls.join(', ')}`);
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
  const { page } = await open(t, { motion: 'no-preference' });
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

test('a flagged Home deal opens that exact Deals record; unknown IDs show a failed detail instead of another deal', async t => {
  const { page, errors } = await open(t);
  const href = await page.locator('.home-flag').first().getAttribute('href');
  assert.equal(href, '/deals?deal=d01');
  // Keep this synthetic test on the fixture adapter on the receiving page.
  await page.locator('.home-flag').first().click();
  await page.waitForFunction(() => document.querySelector('#recordPanel')?.open && document.querySelector('#detailNextForm'));
  assert.equal(await page.evaluate(async () => (await import('/js/pipeline.js')).state.panelDeal), 'd01');
  assert.match(await page.locator('#panelTitle').textContent(), /Demo Dental North/);
  await page.goto('http://localhost/deals?deal=unknown');
  await page.locator('#recordPanel').getByRole('button', { name: 'Retry', exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await import('/js/pipeline.js')).state.panelDetail), null);
  assert.equal(await page.locator('#detailNextForm').count(), 0);
  assert.deepEqual(errors, []);
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

test('R5 whole refresh deadline preserves completed widgets across multiple hung detail waves', async t => {
  const { page, calls } = await open(t, { hangDetails: true });
  await page.locator('.home-lead').first().waitFor();
  await page.locator('#homeControl:not([hidden])').waitFor();
  for (const ms of [10_001, 10_001, 5_001]) {
    await page.clock.runFor(ms);
    await page.waitForTimeout(20);
  }
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#dealCounts').textContent(), /Active Deals: 12/);
  assert.equal(await page.locator('#homeLeads').isVisible(), true);
  assert.equal(await page.locator('#homeControl').isVisible(), true);
  assert.equal(calls.filter(name => name === 'get-deal-room').length, 12);
});

test('R6 settled board failure shows unavailable rather than Updating and automatic recovery clears it', async t => {
  const state = await open(t); const { page } = state;
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  state.failBoard(true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#dealFlags').textContent(), /unavailable/i);
  assert.match(await page.locator('#observedAt').textContent(), /unavailable|partial/i);
  assert.equal(await page.locator('#homeNotice').isVisible(), true);
  assert.equal(await page.locator('#dealAttention').getAttribute('aria-busy'), 'false');
  state.failBoard(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#observedAt').textContent(), /^Updated /);
  assert.equal(await page.locator('#homeNotice').isVisible(), false);
});

test('R7 linked Deals detail refusal or timeout cannot prevent board and feed polling', async t => {
  for (const failure of ['503', 'timeout']) await t.test(failure, async t => {
    const state = await open(t, { delayInitialFeed: true }); const { page } = state;
    // Finish Home's detail wave before observing the receiving Deals request.
    // Otherwise a late Home request can advance the clock before Deals starts its deadline.
    await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
    state.failDetails(failure);
    const firstFeed = page.waitForRequest('**/pipeline/changes');
    const detailRead = page.waitForRequest(request => new URL(request.url()).pathname === '/mcp'
      && request.postDataJSON()?.params?.name === 'get-deal-room'
      && new URL(request.frame().url()).pathname === '/deals');
    await page.goto('http://localhost/deals?mode=live&deal=d01');
    await page.locator('.kanban-card').first().waitFor();
    await firstFeed;
    state.releaseInitialFeed();
    await detailRead;
    await page.clock.runFor(10_001);
    await page.locator('#recordPanel').getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.match(await page.locator('#panelBody').textContent(), /Deal details could not be read/);
    assert.equal(await page.locator('#recordPanel').getByRole('button', { name: 'Close deal', exact: true }).isVisible(), true);
    const before = [state.boardReads, state.feedReads];
    const nextBoard = page.waitForResponse(response => new URL(response.url()).pathname === '/mcp'
      && response.request().postDataJSON()?.params?.name === 'deal-room-board');
    const nextFeed = page.waitForResponse(response => new URL(response.url()).pathname === '/pipeline/changes');
    await page.clock.runFor(65_000);
    await Promise.all([nextBoard, nextFeed]);
    assert.ok(state.boardReads > before[0], 'board refresh continues');
    assert.ok(state.feedReads > before[1], 'feed polling continues');
  });
});

test('R9 identical refresh retains lead and deal focus; modal repaint retains exact link or button', async t => {
  const state = await open(t); const { page } = state;
  const settled = () => page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  await settled();
  for (const selector of ['.home-lead', '.home-flag']) {
    await page.locator(selector).first().focus();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await settled();
    assert.equal(await page.locator(selector).first().evaluate(node => document.activeElement === node), true, selector);
  }
  await page.locator('.home-lead').first().click();
  for (const selector of ['#homeDetail a', '#homeDetail [data-close-detail]', '#homeDetail summary']) {
    await page.locator(selector).focus();
    state.updateLead('demo-lead-0', 97 + selector.length);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await settled();
    assert.equal(await page.locator(selector).evaluate(node => document.activeElement === node), true, selector);
  }
});

test('R10 failed or timed-out leads cannot leave open detail falsely current', async t => {
  for (const failure of [503, 'timeout']) await t.test(String(failure), async t => {
    const state = await open(t); const { page } = state;
    await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
    await page.locator('.home-lead').first().click();
    state.failLeads(failure);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    if (failure === 'timeout') await page.clock.runFor(10_001);
    await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#homeDetail').evaluate(dialog => dialog.open), false);
    assert.equal(await page.locator('#homeNotice').isVisible(), true);
    state.failLeads(null);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#homeLeads').isVisible(), true);
  });
});

test('R11 live lead authorization refusals show Sign in and close prior detail', async t => {
  for (const status of [401, 403]) await t.test(String(status), async t => {
    const state = await open(t); const { page } = state;
    await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
    await page.locator('.home-lead').first().click();
    state.failLeads(status);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
    assert.equal(await page.getByRole('link', { name: 'Sign in', exact: true }).isVisible(), true);
    assert.equal(await page.locator('#homeDetail').evaluate(dialog => dialog.open), false);
    assert.equal(await page.locator('#homeLeads').isVisible(), false);
  });
});

test('R13 phone lead detail wraps specialty, maximum-length names and metadata within the dialog', async t => {
  for (const width of [320, 390]) await t.test(String(width), async t => {
    const { page } = await open(t, { width, longLead: true });
    await page.locator('.home-lead').first().click();
    await page.locator('#homeDetail summary').click();
    assert.equal(await page.locator('#homeDetail').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true);
    assert.equal(await page.locator('#homeDetailBody').evaluate(body => body.scrollWidth <= body.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot(page, `phone-long-detail-${width}`);
  });
});

test('R14 a task with no critical dates opens its exact deal and visible task', async t => {
  const { page } = await open(t, { tasksOnly: true });
  const task = page.locator('[data-home-key="agenda:task:demo-task-d01"]');
  await task.waitFor();
  assert.equal(await task.getAttribute('href'), '/deals?deal=d01');
  await task.click();
  await page.waitForFunction(() => document.querySelector('#recordPanel')?.open && document.querySelector('#detailNextForm'));
  assert.equal(await page.evaluate(async () => (await import('/js/pipeline.js')).state.panelDeal), 'd01');
  assert.match(await page.locator('#panelBody').textContent(), /Demo follow-up/);
});

test('R12 malformed tasks retain independent widgets and settled agenda reports partial data', async t => {
  const { page, errors } = await open(t, { malformedTasks: true });
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#dealCounts').textContent(), /Active Deals: \d/);
  assert.equal(await page.locator('#homeLeads').isVisible(), true);
  assert.equal(await page.locator('#homeControl').isVisible(), true);
  assert.match(await page.locator('#homeCalendar').textContent(), /unavailable|missing/i);
  assert.doesNotMatch(await page.locator('#homeCalendar').textContent(), /updating/i);
  assert.deepEqual(errors, []);
});

test('R9 agenda focus survives independent responses while the shared board is still loading', async t => {
  const { page } = await open(t, { delayBoard: true });
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  const task = page.locator('[data-home-key="agenda:task:demo-task-d01"]');
  await task.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.equal(await task.evaluate(node => document.activeElement === node), true);
});
