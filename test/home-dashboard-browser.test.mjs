import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, settles } from './browser-harness.mjs';
import { relationshipNetworkFixture } from '../js/relationship-network-fixture.js';
import { createFixtureClient } from '../js/fixture-client.js';
import axe from 'axe-core';

const NOW = new Date('2026-10-01T15:00:00Z');
const { routes } = (await import("../js/routes.js")).routeContract;
const leadRows = [96, 88, 71, 23].map((score, i) => ({ id: `demo-lead-${i}`, name: `Demo New Practice ${i + 1}`, specialty: 'Demo specialty', city: 'Demo City', score,
  owner: i === 0 ? 'dell' : 'joe', owner_label: 'Demo partner', stage: 'new', stage_label: 'New', created_at: NOW.toISOString() }));
const screenshot = async (page, name) => {
  if (!process.env.W2_SCREENSHOT_DIR) return;
  await mkdir(process.env.W2_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.W2_SCREENSHOT_DIR, `${name}.png`), fullPage: !name.includes('detail') });
};

async function open(t, { width = 1440, height = 1000, invoiceAttention = false, motion = 'reduce', leads = true, delayDetails = false, hangDetails = false, longLead = false, tasksOnly = false, heldTasks = false, malformedTasks = false, delayBoard = false, delayInitialFeed = false, origin = 'http://localhost', malformedBoard = false, firstOpen = false, emptyAgenda = false, initialDetailFailure = null } = {}) {
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}` });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, timezoneId: 'UTC', reducedMotion: motion });
  // Virtual time pauses CSS transitions. Data journeys use reduced motion so
  // actionability cannot wait on a hover transition the clock never advances.
  await page.clock.install({ time: NOW });
  if (!firstOpen) await page.addInitScript(() => {
    if (!localStorage.getItem('doctorcre:morning:joe')) localStorage.setItem('doctorcre:morning:joe', JSON.stringify({ day: '2026-10-01', lastShownAt: '2026-10-01T14:00:00Z', since: '2026-09-30T17:00:00Z' }));
  });
  const errors = [], calls = [], liveLeads = structuredClone(leadRows); let boardReads = 0, feedReads = 0, failBoard = false, detailFailure = initialDetailFailure, leadFailure = null;
  const responses = new Map();
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
    'get-deal-room': async args => { if (detailFailure === '503' || (detailFailure === 'partial' && args.deal === 'd01')) throw Error('Unavailable'); if ([401, 403].includes(detailFailure)) throw Object.assign(Error('Refused'), { status: detailFailure }); if (hangDetails || detailFailure === 'timeout') return new Promise(() => {}); if (delayDetails) await new Promise(resolve => setTimeout(resolve, 100)); const detail = await client.getDeal(args.deal); return { ...detail,
      ...detail.deal, deal_id: detail.deal.id, events: detail.history.map(event => ({ ...event, verb: event.verb || 'patch-deal-field' })),
      critical_dates: tasksOnly || emptyAgenda ? [] : [{ id: `demo-date-${args.deal}`, note: 'Demo tour', due_on: '2026-10-03', status: 'open' }],
      next_actions: emptyAgenda ? [] : malformedTasks ? [null] : [{ id: `demo-task-${args.deal}`, description: 'Demo follow-up', due_on: '2026-10-01', status: 'open', owner: detail.deal.owner, hold_until: heldTasks ? '2027-01-01' : null }] }; },
    'read-home-agenda': async () => {
      const board = await handlers['deal-room-board']();
      if (hangDetails) return new Promise(() => {});
      return { schema_version: 'home-agenda.v1', ...board, deals: await Promise.all(board.deals.map(async deal => ({
        ...deal, ...await handlers['get-deal-room']({ deal: deal.id }).catch(error => { if (detailFailure === 'partial') return { critical_dates: null, next_actions: null }; throw error; }),
      }))) };
    },
    'correspondence-readiness': args => client.correspondenceReadiness(args),
    'today-triage': () => client.todayTriage(),
    'list-feature-switches': () => client.listFeatureSwitches(),
    'list-doc-suggestions': args => client.listDocSuggestions(args),
    'morning-brief': () => client.morningBrief(),
    'read-invoice-tracker': () => ({schema_version:'invoice-tracker.v1',actor:'joe',entries:invoiceAttention ? [{ deal_id:'demo-overdue',name:'Demo overdue invoice',commission_id:'demo-invoice',status:'invoiced',owner:'joe',lane:'local',outcome:'won',gross_amount:'100',closed_on:'2026-08-01',invoiced_on:'2026-08-01',commission_invoiced_on:'2026-08-01',received_on:null,due_on:'2026-09-01',as_of:'2026-10-01',base_version:1 }] : [],observed_at:NOW.toISOString()}),
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
      if (!handlers[rpc.params.name]) { errors.push(`Unexpected MCP operation: ${rpc.params.name}`); return route.fulfill({ status: 500, json: { error: 'unexpected_operation' } }); }
      try { return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(responses.has(rpc.params.name) ? responses.get(rpc.params.name) : await handlers[rpc.params.name](rpc.params.arguments)) }] } } }); }
      catch (error) { return route.fulfill({ status: error.status || 503, json: { error: 'Unavailable' } }); }
    }
    if (url.pathname === '/api/v1/business/relationships') return route.fulfill({ json: relationshipNetworkFixture(NOW.toISOString()) });
    if (url.pathname === '/api/system-work/current') return route.fulfill({ json: { ok: true, data: await client.currentWorkRequests() } });
    if (url.pathname === '/pipeline/changes') {
      feedReads++;
      if (delayInitialFeed && feedReads === 1) await initialFeed;
      return route.fulfill({ json: { events: [], cursor: null } });
    }
    if (['/api/system-work/session','/auth/session'].includes(url.pathname)) return route.fulfill({ json: { actor: { slug: 'joe', label: 'Demo partner' }, csrf_token: 'synthetic' } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ status: 503, json: {} });
    const file = url.pathname === '/deals' && url.searchParams.get('view') === 'national' ? 'index.html' : routes[url.pathname] || url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(`../${file}`, import.meta.url)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`${origin}/?mode=live`);
  if (!hangDetails) await page.waitForFunction(() => /Active deals: \d/.test(document.querySelector('#dealCounts')?.textContent || '') || /unavailable/i.test(document.querySelector('#observedAt')?.textContent || ''));
  if (firstOpen) { await page.locator('#docOpen[data-brief-unseen]').waitFor(); await page.locator('#docOpen').click(); await page.locator('#docMorning').click(); await page.locator('#docMorningBrief[open]').waitFor(); await page.waitForFunction(() => document.getElementById('morningUpdated').hasAttribute('datetime')); await page.locator('#morningClose').click(); }
  return { page, errors, calls, releaseInitialFeed, responses, get boardReads() { return boardReads; }, get feedReads() { return feedReads; }, malformBoard(value) { boardMalformed = value; }, failLeads(value) { leadFailure = value; }, failDetails(value) { detailFailure = value; }, failBoard(value) { failBoard = value; }, updateLead(id, score) { liveLeads.find(row => row.id === id).score = score; } };
}

test('PR123 R1: Home models the daily morning brief and rejects unknown operations', async t => {
  const { page, calls, errors } = await open(t, { firstOpen: true });
  const preference = () => page.evaluate(() => JSON.parse(localStorage.getItem('doctorcre:morning:joe')));
  assert.equal((await preference())?.day, '2026-10-01');
  assert.ok(calls.includes('morning-brief'));
  assert.equal(await page.locator('#docMorningBrief').evaluate(dialog => dialog.open), false);
  assert.equal(await page.locator('#morningCoverage').textContent(), '');
  const loaded = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postDataJSON()?.params?.name === 'morning-brief');
  await page.reload(); await loaded;
  await page.waitForFunction(() => document.querySelector('#morningUpdated')?.hasAttribute('datetime'));
  assert.equal(await page.locator('#docMorningBrief').evaluate(dialog => dialog.open), false);
  await page.locator('#docOpen').click(); await page.locator('#docMorning').click();
  await page.locator('#docMorningBrief[open]').waitFor(); await page.waitForFunction(() => document.getElementById('morningUpdated').hasAttribute('datetime'));
  await page.locator('#morningClose').click();
  await page.clock.setSystemTime(new Date('2026-10-02T15:00:00Z'));
  // A day without input is idle: coming back online reads nothing until the
  // person returns, and that first input reads the new day's brief.
  const briefReads = calls.filter(name => name === 'morning-brief').length;
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForTimeout(200);
  assert.equal(calls.filter(name => name === 'morning-brief').length, briefReads);
  assert.equal(await page.locator('#docMorningBrief').evaluate(dialog => dialog.open), false);
  assert.equal((await preference()).day, '2026-10-01');
  await page.mouse.move(10, 10); await page.mouse.move(20, 20);
  await page.locator('#docOpen[data-brief-unseen]').waitFor();
  assert.equal(await page.locator('#docMorningBrief').evaluate(dialog => dialog.open), false);
  assert.equal((await preference()).day, '2026-10-01');
  await page.locator('#docOpen').click(); await page.locator('#docMorning').click();
  await page.locator('#docMorningBrief[open]').waitFor(); await page.waitForFunction(() => document.getElementById('morningUpdated').hasAttribute('datetime'));
  assert.ok(calls.filter(name => name === 'morning-brief').length > briefReads);
  assert.equal((await preference()).day, '2026-10-02');
  assert.deepEqual(errors, []);
  const status = await page.evaluate(async () => (await fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unknown-operation', arguments: {} } }) })).status);
  assert.equal(status, 500);
  assert.deepEqual(errors, ['Unexpected MCP operation: unknown-operation']);
});

test('PR123 finding 8: malformed and mixed live reads settle unavailable and recover', async t => {
  const state = await open(t); const { page, responses } = state;
  const settled = () => page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  const refresh = async () => {
    const read = page.waitForResponse(response => new URL(response.url()).pathname === '/mcp'
      && response.request().postDataJSON()?.params?.name === 'lead-board');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await read; await settled();
  };
  await settled();
  for (const [name, payloads] of [
    ['read-home-agenda', [{}, { deals: [{ name: 'Missing identity' }] }, { deals: [{ id: 'demo-valid', name: 'Demo valid' }, { name: 'Missing identity' }] }]],
    ['lead-board', [{}, { leads: [{ score: 99, created_at: NOW.toISOString() }] }, { leads: [leadRows[0], null] }]],
  ]) for (const payload of payloads) await t.test(`${name}: ${JSON.stringify(payload)}`, async () => {
    if (name === 'lead-board') await page.locator('.home-lead').first().click();
    responses.set(name, payload);
    try {
      await refresh();
      assert.equal(await page.locator('#homeNotice').isVisible(), true);
      assert.match(await page.locator('#observedAt').textContent(), /unavailable|partial/i);
      assert.equal(await page.locator('#dealAttention').getAttribute('aria-busy'), 'false');
      if (name === 'read-home-agenda') {
        assert.match(await page.locator('#dealCounts').textContent(), /Active deals: —/);
        assert.match(await page.locator('#dealFlags').textContent(), /unavailable/i);
        assert.doesNotMatch(await page.locator('#dealFlags').textContent(), /Updating|No deal flags|No overdue local next steps/);
        assert.equal(await page.locator('#homeLeads').isVisible(), true);
      } else {
        assert.match(await page.locator('#dealCounts').textContent(), /Active deals: \d/);
        assert.equal(await page.locator('#homeDetail').evaluate(dialog => dialog.open), false);
      }
    } finally { responses.delete(name); await refresh(); }
    assert.equal(await page.locator('#homeNotice').isVisible(), false);
    assert.match(await page.locator('#observedAt').textContent(), /^Updated /);
    assert.equal(await page.locator('#homeLeads').isVisible(), true);
  });
  assert.deepEqual(state.errors, []);
});

test('PR124 R1 generated Home flag and task links open the requested record through the deployed route', async t => {
  const { page, errors } = await open(t, { origin: 'https://app.doctorcre.com' });
  for (const selector of ['.home-flag', '.home-agenda a:has(.home-item-type:text-is("Task"))']) {
    await page.locator(selector).first().waitFor();
    const link = page.locator(selector).first();
    const id = new URL(await link.getAttribute('href'), page.url()).searchParams.get('deal');
    assert.ok(id);
    await link.click();
    await page.locator('.kanban-card').first().waitFor();
    await page.waitForFunction(id => document.querySelector('#recordPanel')?.open && document.querySelector('#detailUpdateForm') && document.querySelector('#detailOwner'), id);
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
  assert.match(await page.locator('#dealCounts').textContent(), /Active deals: [1-9]/);
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
    assert.equal(await page.locator('#homeControl, .home-radar').count(), 0);
    assert.equal(await page.locator('.home-week .home-day').count(), 7);
    // The week link names its destination before the day tiles it wraps.
    assert.equal(await page.getByRole('link', { name: /^Open calendar\b.*deal dates and tasks/ }).getAttribute('data-home-key'), 'week');
    assert.equal(await page.locator('.home-lead').count(), 3);
    assert.equal(await page.locator('.home-flags .home-flag').count(), 3);
    assert.equal(calls.some(name => ['incident-board', 'current-work-item', 'read-resource-dashboard', 'schedule-board'].includes(name)), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.match(await page.locator('#observedAt').textContent(), /^Updated /);
    const text = await page.locator('main').textContent();
    assert.doesNotMatch(text, /source|records read|read again|retry|Doc at work|Changed in 7 days|Workspace structure/i);
    assert.ok(calls.every(name => Object.keys({ 'morning-brief':1, 'read-invoice-tracker':1, 'today-triage':1,'list-feature-switches': 1, 'list-doc-suggestions': 1, 'read-home-agenda': 1, 'deal-room-board': 1, 'get-deal-room': 1, 'lead-board': 1, 'incident-board': 1, 'current-work-item': 1, 'read-resource-dashboard': 1, 'schedule-board': 1, 'list-notifications': 1, 'notification-feed': 1 }).includes(name)), `no write verb runs: ${calls.join(', ')}`);
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
    await page.getByRole('button', { name: 'Just me', exact: true }).click();
    assert.equal(await page.locator('.home-flags .home-flag').count(), 2);
    assert.match(await page.locator('.home-lead').first().textContent(), /Demo New Practice 2/);
    await page.getByRole('button', { name: 'Just me', exact: true }).press('ArrowLeft');
    assert.equal(await page.getByRole('button', { name: 'Team view', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []);
  });
});

test('suggested introductions keep readable text on their dark cards in both themes', async t => {
  const { page, errors } = await open(t);
  await page.locator('#homeIntroductions .relationship-card').first().waitFor();
  await page.addScriptTag({ content: axe.source });
  for (const theme of ['dark', 'light']) {
    if ((await page.locator('[data-pref="theme"]').getAttribute('aria-pressed') === 'true') !== (theme === 'dark')) await page.locator('[data-pref="theme"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme || 'dark'), theme);
    const audit = await page.evaluate(() => window.axe.run(document.querySelector('#homeIntroductions'), { runOnly: ['color-contrast'] }));
    assert.deepEqual(audit.violations.flatMap(v => v.nodes.map(n => n.target.join(' '))), [], `${theme}: introduction text contrast`);
    const card = await page.locator('#homeIntroductions .relationship-card').first().evaluate(node => { const s = getComputedStyle(node); return { border: s.borderTopColor, radius: s.borderTopLeftRadius, hairline: getComputedStyle(document.documentElement).getPropertyValue('--hairline').trim() }; });
    assert.notEqual(card.border, 'rgb(255, 255, 255)', `${theme}: introduction cards use the family hairline, not the browser button border`);
    assert.notEqual(card.radius, '0px', `${theme}: introduction cards are rounded like other cards`);
  }
  assert.deepEqual(errors, []);
});

test('Home has no ambient motion and hover never moves a row, without hiding data', async t => {
  const { page } = await open(t, { motion: 'no-preference', delayDetails: true });
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  await page.locator('.home-radar').waitFor();
  assert.equal(await page.locator('.radar-wave').evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.radar-wave').evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.locator('.home-flag').first().hover();
  assert.equal(await page.locator('.home-flag').first().evaluate(node => getComputedStyle(node).transform), 'none');
  assert.equal(await page.locator('.home-day').count(), 7);
  assert.equal(await page.locator('.home-flag').count(), 3);
  await screenshot(page, 'desktop-reduced-motion');
});

test('no eligible leads means hidden widget; failed Home retains unavailable calendar and automatic recovery', async t => {
  const state = await open(t, { leads: false, delayDetails: true }); const { page } = state;
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#homeLeads').isVisible(), false);
  state.failBoard(true);
  await page.clock.fastForward(31_000);
  // Recover only after the failing refresh ends: a resume during it joins that read.
  await page.waitForFunction(() => document.querySelector('#dealCounts').textContent.includes('Active deals: —') && document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#homeCalendar').isVisible(), true);
  assert.match(await page.locator('#homeCalendar').textContent(), /Calendar and tasks unavailable/);
  assert.equal(await page.locator('#homeCalendar').getByRole('button', { name: 'Retry calendar and tasks', exact: true }).isVisible(), true);
  state.failBoard(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => /Active deals: \d/.test(document.querySelector('#dealCounts').textContent));
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  const before = state.boardReads;
  const resumed = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postDataJSON()?.params.name === 'read-home-agenda');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForFunction(() => /Active deals: \d/.test(document.querySelector('#dealCounts').textContent));
  await resumed; assert.ok(state.boardReads > before);
  assert.deepEqual(state.errors, []);
});

test('a flagged Home deal opens that exact Deals record; unknown IDs show a failed detail instead of another deal', async t => {
  const { page, errors } = await open(t);
  const href = await page.locator('.home-flag').first().getAttribute('href');
  assert.equal(href, '/deals?deal=d14');
  // Keep this synthetic test on the fixture adapter on the receiving page.
  await page.locator('.home-flag').first().click();
  await page.waitForFunction(() => document.querySelector('#recordPanel')?.open && document.querySelector('#detailUpdateForm'));
  assert.equal(await page.evaluate(async () => (await import('/js/pipeline.js')).state.panelDeal), 'd14');
  assert.match(await page.locator('#panelTitle').textContent(), /Demo Surgical Practice/);
  await page.goto('http://localhost/deals?deal=unknown');
  await page.locator('#panelBody').getByText('Updates temporarily unavailable',{exact:true}).waitFor();
  assert.equal(await page.evaluate(async () => (await import('/js/pipeline.js')).state.panelDetail), null);
  assert.equal(await page.locator('#detailUpdateForm').count(), 0);
  assert.deepEqual(errors, []);
});

test('an open lead detail updates automatically while preserving expanded Details and focus', async t => {
  const state = await open(t); const { page } = state;
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  await page.locator('.home-lead').first().click();
  await page.locator('#homeDetail summary').click();
  assert.equal(await page.locator('#homeDetail summary').evaluate(node => document.activeElement === node), true);
  state.updateLead('demo-lead-0', 97);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('.home-detail-score')?.textContent.includes('97')
    && document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#homeDetail details').evaluate(node => node.open), true);
  assert.equal(await page.locator('#homeDetail summary').evaluate(node => document.activeElement === node), true);
  assert.deepEqual(state.errors, []);
});

for (const width of [320, 390]) test(`phone agenda keeps its loading space ahead of independently ready widgets at ${width}`, async t => {
  const { page, responses, errors } = await open(t, { width, height: 844, hangDetails: true, invoiceAttention: true });
  await page.locator('#homeInvoices .home-flag').waitFor();
  await page.locator('#homeControl:not([hidden])').waitFor();
  assert.match(await page.locator('#homeInvoices').textContent(), /Demo overdue invoice/);
  const calendar = page.locator('#homeCalendar');
  assert.equal(await calendar.getAttribute('aria-busy'), 'true');
  assert.ok((await calendar.boundingBox()).height >= 400, 'reserve the phone agenda preview while its read is pending');
  assert.ok(await calendar.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('#homeInvoices')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  assert.ok((await page.locator('#homeInvoices h2').boundingBox()).y >= 844, 'optional content follows the critical loading region');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  await screenshot(page, `phone-agenda-loading-${width}`);
  for (const ms of [10_001, 10_001, 5_001]) { await page.clock.runFor(ms); await page.waitForTimeout(20); }
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.equal(await calendar.getAttribute('aria-busy'), 'false');
  assert.match(await calendar.textContent(), /Calendar and tasks unavailable/);
  assert.ok((await calendar.boundingBox()).height < 400, 'an unavailable agenda releases its loading space');
  assert.equal(await page.locator('#homeInvoices').isVisible(), true);
  await screenshot(page, `phone-agenda-unavailable-${width}`);
  responses.set('read-home-agenda', { schema_version: 'home-agenda.v1', actor: 'joe', deals: [] });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#homeCalendar').textContent.includes('No calendar dates or tasks'));
  assert.equal(await calendar.getAttribute('aria-busy'), 'false');
  assert.ok((await calendar.boundingBox()).height < 400, 'a verified empty agenda stays compact');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  await screenshot(page, `phone-agenda-empty-${width}`);
  assert.deepEqual(errors, []);
});

test('R5 agenda deadline preserves independent completed widgets', async t => {
  const { page, calls } = await open(t, { hangDetails: true });
  await page.locator('.home-lead').first().waitFor();
  await page.locator('#homeControl:not([hidden])').waitFor();
  for (const ms of [10_001, 10_001, 5_001]) {
    await page.clock.runFor(ms);
    await page.waitForTimeout(20);
  }
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#dealFlags').textContent(), /unavailable/i);
  assert.equal(await page.locator('#homeLeads').isVisible(), true);
  assert.equal(await page.locator('#homeControl').isVisible(), true);
  assert.equal(calls.filter(name => name === 'get-deal-room').length, 0);
  assert.equal(calls.filter(name => name === 'read-home-agenda').length, 1);
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
    await page.locator('#panelBody').getByText('Updates temporarily unavailable',{exact:true}).waitFor();
    assert.match(await page.locator('#panelBody').textContent(), /Updates temporarily unavailable/);
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
  for (const selector of ['#homeDetail [data-home-key="detail:leads"]', '#homeDetail [data-close-detail]', '#homeDetail summary']) {
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
    await page.waitForURL('**/public-shell/session-ended.html');
    assert.equal(await page.getByRole('link',{name:'Sign in again'}).isVisible(),true);
    assert.equal(await page.locator('#homeDetail, #homeLeads').count(),0);
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

test('R14 a task with no critical dates opens its exact deal and recorded next step', async t => {
  const { page } = await open(t, { tasksOnly: true });
  const task = page.locator('[data-home-key="agenda:task:demo-task-d01"]');
  await task.waitFor();
  assert.equal(await task.getAttribute('href'), '/deals?deal=d01');
  await task.click();
  await page.waitForFunction(() => document.querySelector('#recordPanel')?.open && document.querySelector('#detailUpdateForm'));
  assert.equal(await page.evaluate(async () => (await import('/js/pipeline.js')).state.panelDeal), 'd01');
  assert.equal(await page.locator('.deal-current-action strong').textContent(), 'Confirm fictional requirements');
});

test('R12 malformed tasks retain independent widgets and settled agenda reports partial data', async t => {
  const { page, errors } = await open(t, { malformedTasks: true });
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#dealCounts').textContent(), /Active deals: \d/);
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

test('Home hides held tasks, ranks eligible arrivals, and links the full prospecting queue', async t => {
  const { page, responses } = await open(t, { heldTasks: true });
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#homeAgenda a').filter({ hasText: 'Demo follow-up' }).count(), 0);
  responses.set('lead-board', { leads: [
    { ...leadRows[0], id:'synthetic-suppressed', name:'Demo Suppressed', score:100, suppressed:true },
    { ...leadRows[0], id:'synthetic-converted', name:'Demo Converted', score:99, stage:'closed_won' },
    { ...leadRows[1], id:'synthetic-eligible', name:'Demo Eligible', score:10 },
  ] });
  const read = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postDataJSON()?.params?.name === 'lead-board');
  await page.locator('#refreshHome').click(); await read;
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#homeLeads h2').textContent(), 'Recent arrivals');
  assert.deepEqual(await page.locator('.home-lead strong').allTextContents(), ['Demo Eligible']);
  assert.equal(await page.getByRole('link', { name:'Prospecting queue' }).getAttribute('href'), '/leads');
});

test('held deal actions remain visible in the deal history reached from Home', async t => {
  const { page } = await open(t, { heldTasks: true });
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  const href = await page.locator('#dealFlags a').first().getAttribute('href');
  await page.goto('http://localhost' + href + '&mode=live');
  await page.locator('.updates-history').waitFor();
  await page.locator('.updates-history').click();
  assert.ok(await page.getByText('Held until Jan 1, 2027', {exact:true}).count());
  assert.ok(await page.locator('.deal-note').filter({hasText:'Demo follow-up'}).count());
});

for (const failure of [null, '503']) test(`Slice A Calendar distinguishes confirmed empty from unavailable: ${failure}`, async t => {
 const state = await open(t, { emptyAgenda: true, initialDetailFailure: failure });
 const { page, calls } = state;
 await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
 const calendar = page.locator('#homeCalendar');
 assert.equal(await calendar.isVisible(), true);
 assert.match(await calendar.textContent(), /Calendar & tasks/);
 if (!failure) {
  assert.match(await calendar.textContent(), /No .*dates.*tasks/i);
  assert.doesNotMatch(await calendar.textContent(), /unavailable|updating/i);
 } else {
  assert.match(await calendar.textContent(), /unavailable/i);
  assert.doesNotMatch(await calendar.textContent(), /No .*dates.*tasks/i);
  state.failDetails(null);
  const before = calls.length;
  await calendar.getByRole('button', { name: 'Retry calendar and tasks', exact: true }).click();
  await page.waitForFunction(() => /No .*dates.*tasks/i.test(document.querySelector('#homeCalendar').textContent));
  const retried = calls.slice(before);
  assert.ok(retried.includes('read-home-agenda'));
  assert.equal(retried.includes('get-deal-room'), false);
  assert.equal(retried.includes('lead-board'), false, 'agenda retry does not reload unrelated widgets');
  assert.equal(retried.includes('read-invoice-tracker'), false);
 }
 assert.deepEqual(state.errors, []);
});

test('Slice A Calendar stays visible while all detail reads are pending', async t => {
 const { page } = await open(t, { hangDetails: true });
 assert.equal(await page.locator('#homeCalendar').isVisible(), true);
 assert.match(await page.locator('#homeCalendar').textContent(), /updating|loading/i);
 assert.doesNotMatch(await page.locator('#homeCalendar').textContent(), /No .*dates.*tasks/i);
});


test('Slice A Calendar with successful empty details and failed details stays partial', async t => {
 const { page } = await open(t, { emptyAgenda: true, initialDetailFailure: 'partial' });
 await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
 const calendar = page.locator('#homeCalendar');
 assert.equal(await calendar.isVisible(), true);
 assert.match(await calendar.textContent(), /Some dates unavailable or missing/);
 assert.doesNotMatch(await calendar.textContent(), /No calendar dates or tasks|Calendar and tasks unavailable/);
 assert.equal(await calendar.getByRole('button', { name: 'Retry calendar and tasks', exact: true }).isEnabled(), true);
});

for (const status of [401, 403]) test(`Slice A Calendar retry honors authorization refusal: ${status}`, async t => {
 const state = await open(t, { initialDetailFailure: '503' });
 const { page } = state;
 await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
 await page.locator('.home-lead').first().click();
 await page.keyboard.press('Escape');
 state.failDetails(status);
 await page.locator('#homeCalendar').getByRole('button', { name: 'Retry calendar and tasks', exact: true }).click();
 await page.waitForURL('**/public-shell/session-ended.html');
 assert.equal(await page.locator('#homeCalendar,#homeLeads,#homeDetail').count(), 0);
 assert.match(await page.locator('body').textContent(), /Session ended/);
 assert.equal(await page.getByRole('link', {name:'Sign in again',exact:true}).getAttribute('href'), '/auth/login');
 assert.deepEqual(state.errors, []);
});

test('Slice A Calendar retry clears unrelated private data when the board actor changes', async t => {
 const state = await open(t, { initialDetailFailure: '503' });
 const { page, responses } = state;
 await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
 const board = await page.evaluate(async () => (await (await import('/js/home-boot.js')).homeClient).getBoard());
 await page.locator('.home-lead').first().click();
 await page.keyboard.press('Escape');
 responses.set('read-home-agenda', { ...board, schema_version: 'home-agenda.v1', actor: 'dell', deals: board.deals.map(deal => ({ ...deal, critical_dates: [], next_actions: [] })) });
 state.failDetails(null);
 await page.locator('#homeCalendar').getByRole('button', { name: 'Retry calendar and tasks', exact: true }).click();
 await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
 assert.equal(await page.locator('#homeLeads').isVisible(), false);
 assert.equal(await page.locator('#homeDetail').evaluate(dialog => dialog.open), false);
});
