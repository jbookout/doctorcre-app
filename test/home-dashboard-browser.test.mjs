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

async function open(t, { calendar, initialBriefFailure = false, theme = 'dark', delayHome = false, width = 1440, height = 1000, invoiceAttention = false, motion = 'reduce', leads = true, delayDetails = false, hangDetails = false, longLead = false, tasksOnly = false, heldTasks = false, malformedTasks = false, delayBoard = false, delayInitialFeed = false, origin = 'http://localhost', malformedBoard = false, firstOpen = false, freshBrief = false, emptyAgenda = false, initialDetailFailure = null } = {}) {
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}` });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, timezoneId: 'UTC', reducedMotion: motion });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
  // Virtual time pauses CSS transitions. Data journeys use reduced motion so
  // actionability cannot wait on a hover transition the clock never advances.
  await page.clock.install({ time: NOW });
  if (!firstOpen && !freshBrief) await page.addInitScript(() => {
    if (!localStorage.getItem('doctorcre:morning:joe')) localStorage.setItem('doctorcre:morning:joe', JSON.stringify({ day: '2026-10-01', lastShownAt: '2026-10-01T14:00:00Z', since: '2026-09-30T17:00:00Z' }));
  });
  const resources = []; page.on('request', request => resources.push(new URL(request.url()).pathname));
  const errors = [], calls = [], liveLeads = structuredClone(leadRows); let boardReads = 0, feedReads = 0, failBoard = false, detailFailure = initialDetailFailure, leadFailure = null;
  const responses = new Map();
  let boardMalformed = malformedBoard, briefFailure = initialBriefFailure;
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
    'list-fact-review': args => client.listFactReview(args),
    'list-deal-documents': args => client.listDealDocuments(args),
    'deal-room-board': async () => { boardReads++; if (delayBoard) await new Promise(resolve => setTimeout(resolve, 100)); if (failBoard) throw Error('Unavailable'); const board = await client.getBoard(); if (boardMalformed) return { ...board, deals: [{ name: 'Demo missing record identity' }] }; return hangDetails ? { ...board, deals: Array.from({ length: 12 }, (_, i) => ({ ...board.deals[0], id: `demo-${i}`, operating_state: 'active' })) } : board; },
    'get-deal-room': async args => { if (detailFailure === '503' || (detailFailure === 'partial' && args.deal === 'd01')) throw Error('Unavailable'); if ([401, 403].includes(detailFailure)) throw Object.assign(Error('Refused'), { status: detailFailure }); if (hangDetails || detailFailure === 'timeout') return new Promise(() => {}); if (delayDetails) await new Promise(resolve => setTimeout(resolve, 100)); const detail = await client.getDeal(args.deal); return { ...detail,
      ...detail.deal, deal_id: detail.deal.id, events: detail.history.map(event => ({ ...event, verb: event.verb || 'patch-deal-field' })),
      critical_dates: tasksOnly || emptyAgenda ? [] : [{ id: `demo-date-${args.deal}`, note: 'Demo tour', due_on: '2026-10-03', status: 'open' }],
      next_actions: emptyAgenda ? [] : malformedTasks ? [null] : [{ id: `demo-task-${args.deal}`, description: 'Demo follow-up', due_on: ['d14', 'd20', 'd23'].includes(args.deal) ? '2026-09-30' : '2026-10-01', status: 'open', owner: detail.deal.owner, hold_until: heldTasks ? '2027-01-01' : null }] }; },
    'list-practice-origination': () => ({ok:true,contract:'practice-origination.v1',cards:[],coverage:[],next_cursor:null,outreach_started:false}),
    'read-home-agenda': async () => {
      const board = await handlers['deal-room-board']();
      if (hangDetails) return new Promise(() => {});
      return { ...board, schema_version: 'home-agenda.v1', deals: await Promise.all(board.deals.map(async deal => ({
        ...deal, ...await handlers['get-deal-room']({ deal: deal.id }).catch(error => { if (detailFailure === 'partial') return { critical_dates: null, next_actions: null }; throw error; }),
      }))) };
    },
    'correspondence-readiness': args => client.correspondenceReadiness(args),
    'read-post-call-followups': () => client.getPostCallFollowups(),
    'today-triage': () => client.todayTriage(),
    'list-feature-switches': () => client.listFeatureSwitches(),
    'list-doc-suggestions': args => client.listDocSuggestions(args),
    'morning-brief': async () => { if (briefFailure) throw Error('Unavailable'); const brief = await client.morningBrief(); return calendar === undefined ? brief : { ...brief, sections: { ...brief.sections, calendar } }; },
    'read-invoice-tracker': () => ({schema_version:'invoice-tracker.v1',actor:'joe',entries:invoiceAttention ? [{ deal_id:'demo-overdue',name:'Demo overdue invoice',commission_id:'demo-invoice',status:'invoiced',owner:'joe',lane:'local',outcome:'won',gross_amount:'100',closed_on:'2026-08-01',invoiced_on:'2026-08-01',commission_invoiced_on:'2026-08-01',received_on:null,due_on:'2026-09-01',as_of:'2026-10-01',base_version:1 }] : [],observed_at:NOW.toISOString()}),
    'lead-board': async () => { if (leadFailure === 'timeout') return new Promise(() => {}); if (leadFailure) { const error = Error('Refused'); error.status = leadFailure; throw error; } return { leads: leads ? liveLeads : [] }; },
    'incident-board': () => client.incidentBoard(), 'current-work-item': () => client.currentWorkItem(),
    'read-resource-dashboard': () => client.readResourceDashboard(), 'schedule-board': () => client.scheduleBoard(),
    'list-notifications': async () => ({ unread_count: 0, notifications: [] }),
    'notification-feed': async () => ({ unread_count: 0, notifications: [] }),
    'list-email-proposals': async args => ({ schema_version: args.mode === 'recent_outcomes' ? 'email-reply-outcomes.v1' : 'email-proposals.v1', proposals: [], send: false, more: false, next_cursor: null }),
    'list-email-thread-filings': async () => ({ filings: [] }),
    'read-call-outcomes': async () => ({ schema_version: 'call-outcomes.v1', calls: [], send: false }),
    'calendar-meeting-prep': () => client.calendarMeetingPrep(),
    'answer-board-question': args => client.answerBoardQuestion(args),
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/mcp') {
      const rpc = route.request().postDataJSON(); calls.push(rpc.params.name);
      if (!handlers[rpc.params.name]) { errors.push(`Unexpected MCP operation: ${rpc.params.name}`); return route.fulfill({ status: 500, json: { error: 'unexpected_operation' } }); }
      try { return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(responses.has(rpc.params.name) ? await responses.get(rpc.params.name) : await handlers[rpc.params.name](rpc.params.arguments)) }] } } }); }
      catch (error) { return route.fulfill({ status: error.status || 503, json: { error: 'Unavailable' } }); }
    }
    if (url.pathname === '/api/v1/business/relationships') return route.fulfill({ json: relationshipNetworkFixture(NOW.toISOString()) });
    if (url.pathname === '/api/system-work/current') { calls.push('current-work-requests'); return route.fulfill({ json: { ok: true, data: await client.currentWorkRequests() } }); }
    if (url.pathname === '/pipeline/changes') {
      feedReads++;
      if (delayInitialFeed && feedReads === 1) await initialFeed;
      return route.fulfill({ json: { events: [], cursor: null } });
    }
    if (['/api/system-work/session','/auth/session'].includes(url.pathname)) return route.fulfill({ json: { actor: { slug: 'joe', label: 'Demo partner' }, csrf_token: 'synthetic' } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ status: 503, json: {} });
    const file = url.pathname === '/deals' && url.searchParams.get('view') === 'national' ? 'index.html' : routes[url.pathname] || url.pathname.slice(1);
    if (delayHome && file === 'js/workspace-command-center.js') await page.waitForFunction(() => document.querySelector('#morningUpdated')?.hasAttribute('datetime'));
    try { return route.fulfill({ body: await readFile(new URL(`../${file}`, import.meta.url)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`${origin}/?mode=live`);
  if (!hangDetails) await page.waitForFunction(() => /Active deals: \d/.test(document.querySelector('#dealCounts')?.textContent || '') || /unavailable/i.test(document.querySelector('#observedAt')?.textContent || ''));
  if (firstOpen) { await page.locator('#docOpen[data-brief-unseen]').waitFor(); await page.locator('#docOpen').click(); await page.locator('#docMorning').click(); await page.locator('#docMorningBrief[open]').waitFor(); await page.waitForFunction(() => document.getElementById('morningUpdated').hasAttribute('datetime')); await page.locator('#morningClose').click(); }
  return { page, errors, calls, resources, releaseInitialFeed, responses, failBrief(value) { briefFailure = value; }, get boardReads() { return boardReads; }, get feedReads() { return feedReads; }, malformBoard(value) { boardMalformed = value; }, failLeads(value) { leadFailure = value; }, failDetails(value) { detailFailure = value; }, failBoard(value) { failBoard = value; }, updateLead(id, score) { liveLeads.find(row => row.id === id).score = score; } };
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
    await page.keyboard.press('Shift');
    await page.locator('#refreshHome').evaluate(node=>node.click());
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
        assert.doesNotMatch(await page.locator('#dealFlags').textContent(), /Updating|No deal flags|No overdue next steps/);
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
  for (const selector of ['.home-flag h3 a', '#homeBrief a']) {
    await page.locator(selector).first().waitFor();
    const link = page.locator(selector).first();
    const id = new URL(await link.getAttribute('href'), page.url()).searchParams.get('deal');
    assert.ok(id);
    await link.click();
    await page.locator('.kanban-card').first().waitFor({state:'attached'});
    await page.waitForFunction(id => !document.querySelector('#recordPanel')?.hidden && document.querySelector('#detailUpdateForm') && document.querySelector('#detailOwner'), id);
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
    await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#homeControl, .home-radar').count(), 0);
    // On a phone Control Room waits in More; the bar keeps Home, Leads, Tours and Deals.
    if (width <= 760) await page.getByLabel('More', { exact: true }).click();
    assert.equal(await page.getByRole('link', { name: 'Control Room', exact: true }).count(), 1);
    if (width <= 760) await page.keyboard.press('Escape');
    assert.equal(await page.locator('.home-week .home-day').count(), 7);
    assert.equal(await page.getByRole('region', { name: 'Calendar', exact: true }).getByRole('link', { name: 'Open Calendar', exact: true }).getAttribute('href'), '/calendar');
    assert.equal(await page.locator('.home-lead').count(), 3);
    assert.equal(await page.locator('.home-flags .home-flag').count(), 3);
    await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
    assert.equal(calls.some(name => ['incident-board', 'current-work-item', 'current-work-requests', 'read-resource-dashboard', 'schedule-board'].includes(name)), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.match(await page.locator('#observedAt').textContent(), /^Updated /);
    const text = await page.locator('main').textContent();
    assert.doesNotMatch(text, /source|records read|read again|retry|Doc at work|Changed in 7 days|Workspace structure/i);
    assert.ok(calls.every(name => Object.keys({ 'list-practice-origination':1, 'morning-brief':1, 'read-invoice-tracker':1, 'today-triage':1,'list-feature-switches': 1, 'list-doc-suggestions': 1, 'read-home-agenda': 1, 'read-post-call-followups': 1, 'deal-room-board': 1, 'get-deal-room': 1, 'lead-board': 1, 'list-notifications': 1, 'notification-feed': 1, 'read-call-outcomes': 1, 'list-email-proposals': 1, 'list-email-thread-filings': 1 }).includes(name)), `no write verb runs: ${calls.join(', ')}`);
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.home-flag h3 a').first().hover();
  assert.equal(await page.locator('.home-flag h3 a').first().evaluate(node => getComputedStyle(node).transform), 'none');
  assert.equal(await page.locator('.home-day').count(), 7);
  assert.equal(await page.locator('.home-flag h3 a').count(), 3);
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
  assert.match(await page.locator('#homeCalendar').textContent(), /Calendar unavailable/);
  assert.equal(await page.locator('#homeCalendar').getByRole('button', { name: 'Retry calendar', exact: true }).isVisible(), true);
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

test('a Home flag opens from its row at phone width', async t => {
  const { page } = await open(t, { width: 390, height: 844 });
  // Deal counts paint before the refresh ends; its last render replaces the flag rows.
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  const flag = page.locator('#dealFlags .home-flag').first();
  const href = await flag.locator('h3 a').getAttribute('href');
  await flag.scrollIntoViewIfNeeded();
  const box = await flag.locator('.work-card-meta').boundingBox();
  await page.mouse.click(box.x + box.width - 5, box.y + box.height / 2);
  await page.waitForURL(`http://localhost${href}`, { timeout: 3000 });
});

test('Home flag link opens with Enter and Space, and item links keep their destination', async t => {
  for (const key of ['Enter', 'Space']) {
    const { page } = await open(t, { width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
    const flag = page.locator('#dealFlags .home-flag').first();
    const link = flag.locator('h3 a');
    const href = await link.getAttribute('href');
    await link.focus();
    await page.keyboard.press(key);
    await page.waitForURL(`http://localhost${href}`);
  }
  const { page } = await open(t, { width: 390, height: 844 });
  const item = page.locator('#dealFlags .home-flag .deal-items a').first();
  const href = await item.getAttribute('href');
  await item.click();
  await page.waitForURL(`http://localhost${href}`);
});

test('a flagged Home deal opens that exact Deals record; unknown IDs show a failed detail instead of another deal', async t => {
  const { page, errors } = await open(t);
  const href = await page.locator('.home-flag h3 a').first().getAttribute('href');
  assert.equal(href, '/deals?deal=d14');
  // Keep this synthetic test on the fixture adapter on the receiving page.
  await page.locator('.home-flag h3 a').first().click();
  await page.waitForFunction(() => !document.querySelector('#recordPanel')?.hidden && document.querySelector('#detailUpdateForm'));
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
  assert.match(await calendar.textContent(), /Calendar unavailable/);
  assert.ok((await calendar.boundingBox()).height < 400, 'an unavailable agenda releases its loading space');
  assert.equal(await page.locator('#homeInvoices').isVisible(), true);
  await screenshot(page, `phone-agenda-unavailable-${width}`);
  responses.set('read-home-agenda', { schema_version: 'home-agenda.v1', actor: 'joe', deals: [] });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#homeCalendar').textContent.includes('No calendar dates'));
  assert.equal(await calendar.getAttribute('aria-busy'), 'false');
  assert.ok((await calendar.boundingBox()).height < 400, 'a verified empty agenda stays compact');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  await screenshot(page, `phone-agenda-empty-${width}`);
  assert.deepEqual(errors, []);
});

test('R5 agenda deadline preserves independent completed widgets', async t => {
  const { page, calls } = await open(t, { hangDetails: true });
  await page.locator('.home-lead').first().waitFor();
  for (const ms of [10_001, 10_001, 5_001]) {
    await page.clock.runFor(ms);
    await page.waitForTimeout(20);
  }
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#dealFlags').textContent(), /unavailable/i);
  assert.equal(await page.locator('#homeLeads').isVisible(), true);
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
    await page.locator('.kanban-card').first().waitFor({state:'attached'});
    await firstFeed;
    state.releaseInitialFeed();
    await detailRead;
    await page.clock.runFor(10_001);
    await page.locator('#panelBody').getByText('Updates temporarily unavailable',{exact:true}).waitFor();
    assert.match(await page.locator('#panelBody').textContent(), /Updates temporarily unavailable/);
    assert.equal(await page.locator('#recordPanel').getByRole('button', { name: 'Back to deals', exact: true }).isVisible(), true);
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
  for (const selector of ['.home-lead', '.home-flag h3 a']) {
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

test('R14 a task with no critical dates opens its exact deal with its next action', async t => {
  const { page } = await open(t, { tasksOnly: true });
  const task = page.locator('[data-home-key="brief:task:demo-task-d01"]');
  await task.waitFor();
  assert.equal(await task.getAttribute('href'), '/deals?deal=d01');
  await task.click();
  await page.waitForFunction(() => !document.querySelector('#recordPanel')?.hidden && document.querySelector('#detailUpdateForm'));
  assert.equal(await page.evaluate(async () => (await import('/js/pipeline.js')).state.panelDeal), 'd01');
  assert.equal(await page.locator('.deal-opening-snapshot').count(), 1);
  assert.equal(await page.locator('.deal-current-action strong').textContent(), 'Confirm fictional requirements');
  assert.match(await page.locator('.deal-current-action').textContent(), /^(Overdue action|Next action): Confirm fictional requirements · Due \w{3}, \w{3} \d+, \d{4}$/);
});

test('R12 malformed tasks retain independent widgets and settled agenda reports partial data', async t => {
  const { page, errors } = await open(t, { malformedTasks: true });
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#dealCounts').textContent(), /Active deals: \d/);
  assert.match(await page.locator('#dealCounts').textContent(), /Overdue deals: —/);
  assert.match(await page.locator('#dealFlags').textContent(), /Overdue deals unavailable/);
  assert.equal(await page.locator('#homeLeads').isVisible(), true);
  assert.match(await page.locator('#homeCalendar').textContent(), /unavailable|missing/i);
  assert.doesNotMatch(await page.locator('#homeCalendar').textContent(), /updating/i);
  assert.deepEqual(errors, []);
});

test('R9 agenda focus survives independent responses while the shared board is still loading', async t => {
  const { page } = await open(t, { delayBoard: true });
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  const task = page.locator('[data-home-key="brief:task:demo-task-d01"]');
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
  assert.equal(await page.locator('#dealFlags a').count(), 0);
  const href = await page.locator('#homePrimaryAction').getAttribute('href');
  await page.goto('http://localhost' + href + '?mode=live');
  await page.locator('.kanban-column [data-id="d14"] .card-open').click();
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
 assert.match(await calendar.textContent(), /Calendar/);
 if (!failure) {
  assert.match(await calendar.textContent(), /No .*dates/i);
  assert.doesNotMatch(await calendar.textContent(), /unavailable|updating/i);
 } else {
  assert.match(await calendar.textContent(), /unavailable/i);
  assert.doesNotMatch(await calendar.textContent(), /No .*dates/i);
  state.failDetails(null);
  const before = calls.length;
  await calendar.getByRole('button', { name: 'Retry calendar', exact: true }).click();
  await page.waitForFunction(() => /No .*dates/i.test(document.querySelector('#homeCalendar').textContent));
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
 assert.doesNotMatch(await page.locator('#homeCalendar').textContent(), /No .*dates/i);
});


test('Slice A Calendar with successful empty details and failed details stays partial', async t => {
 const { page } = await open(t, { emptyAgenda: true, initialDetailFailure: 'partial' });
 await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
 const calendar = page.locator('#homeCalendar');
 assert.equal(await calendar.isVisible(), true);
 assert.match(await calendar.textContent(), /Some dates unavailable or missing/);
 assert.doesNotMatch(await calendar.textContent(), /No calendar dates|Calendar unavailable/);
 assert.equal(await calendar.getByRole('button', { name: 'Retry calendar', exact: true }).isEnabled(), true);
});

for (const status of [401, 403]) test(`Slice A Calendar retry honors authorization refusal: ${status}`, async t => {
 const state = await open(t, { initialDetailFailure: '503' });
 const { page } = state;
 await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
 await page.locator('.home-lead').first().click();
 await page.keyboard.press('Escape');
 state.failDetails(status);
 await page.locator('#homeCalendar').getByRole('button', { name: 'Retry calendar', exact: true }).click();
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
 await page.locator('#homeCalendar').getByRole('button', { name: 'Retry calendar', exact: true }).click();
 await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
 assert.equal(await page.locator('#homeLeads').isVisible(), false);
 assert.equal(await page.locator('#homeDetail').evaluate(dialog => dialog.open), false);
});

for (const width of [1440, 390]) test(`Home calendar filters dates while tasks stay in the brief at ${width}`, async t => {
  const { page, responses, errors } = await open(t, { width });
  const board = await page.evaluate(async () => (await (await import('/js/home-boot.js')).homeClient).getBoard());
  const deal = { ...board.deals.find(row => row.id === 'd01'), owner: 'joe',
    critical_dates: [
      { id: 'missed', due_on: '2026-09-30', status: 'open', note: 'Demo missed date' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `today-${i}`, due_on: '2026-10-01', status: 'open', note: `Demo date ${i}` })),
      { id: 'future', due_on: '2026-10-03', status: 'open', note: 'Demo future date' },
    ], next_actions: [{ id: 'task', due_on: null, status: 'open', description: 'Demo undated task', owner: 'joe' }] };
  responses.set('read-home-agenda', { ...board, schema_version: 'home-agenda.v1', deals: [deal] });
  await page.locator('#refreshHome').click();
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  const calendar = page.locator('#homeCalendar');
  await calendar.getByRole('button', { name: 'Today', exact: true }).click();
  assert.equal(await page.locator('#homeAgenda a').count(), 6);
  await calendar.getByRole('button', { name: 'Show all 8', exact: true }).click();
  assert.equal(await page.locator('#homeAgenda a').count(), 8);
  assert.equal(await page.locator('#homeAgenda a').nth(6).evaluate(node => document.activeElement === node), true);
  assert.equal(await page.locator('#homeAgenda a').first().getAttribute('href'), '/calendar?day=2026-10-01&d=2026-10-01');
  await calendar.getByRole('button', { name: 'Overdue', exact: true }).click();
  assert.deepEqual(await page.locator('#homeAgenda strong').allTextContents(), ['Demo missed date']);
  assert.equal(await page.getByText('Demo undated task', { exact: true }).count(), 1);
  assert.equal(await page.locator('#homeBrief').getByText('Demo undated task', { exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Just me', exact: true }).click();
  assert.equal(await page.locator('#homeBrief').getByText('Demo undated task', { exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test('Home shows upcoming meeting time, title, place and attendee count', async t => {
  const { page, errors } = await open(t, { delayHome: true, calendar: { state: 'ready', notes: [], items: [
    { start: '2026-10-01T16:00:00Z', end: '2026-10-01T17:00:00Z', title: 'Demo practice meeting', location: 'Demo office', attendee_count: 3, all_day: false },
  ] } });
  const card = page.getByRole('region', { name: 'Upcoming meetings', exact: true });
  await card.waitFor();
  assert.match(await card.innerText(), /Demo practice meeting/);
  assert.match(await card.innerText(), /Oct 1.*11:00 AM.*CDT/);
  assert.match(await card.innerText(), /Demo office/);
  assert.match(await card.innerText(), /3 attendees/);
  assert.deepEqual(errors, []);
  await screenshot(page, 'home-meetings-desktop');
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await card.isVisible(), false);
  assert.equal(await page.locator('#homeMeetings').textContent(), '');
});


test('Home distinguishes empty, warning and unavailable meeting states and refreshes them', async t => {
  const { page, responses, errors } = await open(t, { width: 390, calendar: { state: 'empty', items: [], notes: [] } });
  const card = page.getByRole('region', { name: 'Upcoming meetings', exact: true });
  await card.waitFor();
  assert.match(await card.innerText(), /No upcoming meetings/);
  const refresh = async (calendar, expected) => {
    responses.set('morning-brief', { sponsor: 'joe', sections: { calendar } });
    await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
    await settles(async () => {
      if (expected) assert.ok((await card.innerText()).includes(expected));
      else assert.equal(await card.isVisible(), false);
    });
  };
  await refresh({ state: 'partial', items: [], notes: [
    'May include meetings you declined or that were cancelled or deleted. Check Outlook.',
    'Invites sent only to a group you belong to are not shown.',
  ] }, 'May include meetings you declined');
  assert.match(await card.innerText(), /May include meetings you declined or that were cancelled or deleted. Check Outlook./);
  assert.match(await card.innerText(), /Invites sent only to a group you belong to are not shown./);
  assert.match(await card.innerText(), /No meetings returned/);
  await screenshot(page, 'home-meetings-warning-phone');
  await refresh({ state: 'ready', notes: [], items: [
    { start: '2026-10-02T05:00:00Z', end: '2026-10-03T05:00:00Z', title: 'Demo all-day visit <script>', location: null, attendee_count: 0, all_day: true },
  ] }, 'Demo all-day visit');
  assert.match(await card.innerText(), /Oct 2.*All day/);
  assert.match(await card.innerText(), /Place not provided/);
  assert.match(await card.innerText(), /0 attendees/);
  assert.equal(await card.locator('script').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await refresh({ state: 'unavailable', items: [] }, 'Meetings unavailable');
  assert.match(await card.innerText(), /Meetings unavailable/);
  assert.doesNotMatch(await card.innerText(), /No upcoming meetings|Demo all-day/);
  await refresh({ state: 'empty', items: [], notes: [] }, 'No upcoming meetings');
  await refresh({ state: 'ready', items: [{ title: 'Demo invalid date', start: 'invalid', attendee_count: 1 }], notes: [] }, 'Meetings unavailable');
  assert.match(await card.innerText(), /Meetings unavailable/);
  assert.doesNotMatch(await card.innerText(), /Invalid Date|Demo invalid date/);
  await refresh(undefined);
  assert.equal(await card.isVisible(), false);
  assert.deepEqual(errors, []);
});


test('Home shows a failed first meeting read with retry and recovers', async t => {
  const { page, failBrief, errors } = await open(t, { initialBriefFailure: true, calendar: { state: 'empty', items: [], notes: [] } });
  const card = page.getByRole('region', { name: 'Upcoming meetings', exact: true });
  await settles(async () => assert.match(await page.locator('#homeMeetings').textContent(), /Meetings unavailable/), 2000);
  assert.equal(await card.isVisible(), true);
  assert.doesNotMatch(await card.innerText(), /No upcoming meetings/);
  failBrief(false);
  await card.getByRole('button', { name: 'Retry meetings', exact: true }).click();
  await settles(async () => assert.match(await card.innerText(), /No upcoming meetings/));
  assert.deepEqual(errors, []);
});

for (const wake of ['visibility', 'online']) test(`Home retains meetings during ${wake} refresh and replaces them when ready`, async t => {
  const { page, responses, errors } = await open(t, { calendar: { state: 'ready', items: [
    { start: '2026-10-01T16:00:00Z', title: 'Demo retained meeting', location: 'Demo office', attendee_count: 3, all_day: false },
  ] } });
  const card = page.getByRole('region', { name: 'Upcoming meetings', exact: true });
  await settles(async () => assert.match(await card.innerText(), /Demo retained meeting/));
  let release;
  responses.set('morning-brief', new Promise(resolve => { release = resolve; }));
  t.after(() => release({ sponsor: 'joe', sections: {} }));
  const pending = page.waitForRequest(request => request.url().endsWith('/mcp') && request.postDataJSON()?.params?.name === 'morning-brief');
  await page.evaluate(wake => {
    if (wake === 'online') { window.dispatchEvent(new Event('online')); return; }
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, wake);
  assert.match(await card.innerText(), /Demo retained meeting/);
  assert.doesNotMatch(await card.innerText(), /unavailable|Couldn't load/);
  if (wake === 'visibility') await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await pending;
  assert.match(await card.innerText(), /Demo retained meeting/);
  assert.doesNotMatch(await card.innerText(), /unavailable|Couldn't load/);
  release({ sponsor: 'joe', sections: { calendar: { state: 'empty', items: [], notes: [] } } });
  await settles(async () => assert.match(await card.innerText(), /No upcoming meetings/));
  assert.doesNotMatch(await card.innerText(), /Demo retained meeting/);
  assert.deepEqual(errors, []);
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) test(`Upcoming meetings stays compact after the brief at ${width}px ${theme}`, async t => {
  const { page, errors } = await open(t, { width, height: width === 390 ? 844 : 900, theme, calendar: {
    state: 'partial', notes: ['Check Outlook for attendance and cancellations.'], items: [
      { start: '2026-10-01T16:00:00Z', title: 'Demo practice meeting', location: 'Demo office', attendee_count: 3, all_day: false },
      { start: '2026-10-02T05:00:00Z', title: 'Demo site visit', location: 'Demo suite', attendee_count: 1, all_day: true },
    ],
  } });
  const card = page.getByRole('region', { name: 'Upcoming meetings', exact: true });
  await settles(async () => assert.match(await card.innerText(), /Demo practice meeting/));
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme || 'dark'), theme);
  assert.match(await card.innerText(), /2 meetings/);
  assert.doesNotMatch(await card.innerText(), /7 days/);
  assert.equal(await card.locator('a, .home-flag').count(), 0);
  const bounds = await card.boundingBox();
  const brief = await page.locator('#homeBrief').boundingBox();
  assert.ok(bounds.y >= brief.y + brief.height, 'open tasks precede meetings');
  await screenshot(page, `home-meetings-${width}-${theme}`);
  for (const row of await card.locator('.home-meeting').all()) { const { height } = await row.boundingBox(); assert.ok(height <= 64, `meeting row uses two compact lines, measured ${height}px`); }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const warning = card.getByText('Check Outlook for attendance and cancellations.', { exact: true });
  assert.notEqual(await warning.evaluate(node => getComputedStyle(node).color), await card.locator('.home-meeting').first().evaluate(node => getComputedStyle(node).color));
  assert.deepEqual(errors, []);
});


const prepCalendar = { state: 'ready', items: [{ title: 'Demo preparation entry', start: '2026-10-01T16:00:00Z', attendee_count: 2 }] };

test('Meeting preparation follows the selected zone and preserves all-day source dates across DST', async t => {
  const { page, responses } = await open(t, { calendar: prepCalendar });
  responses.set('calendar-meeting-prep', { state: 'ready', observed_at: '2026-10-01T14:00:00Z', items: [
    { title: 'Timed meeting', start: '2026-10-01T16:00:00Z', end: '2026-10-01T17:00:00Z', all_day: false, possible_deals: [] },
    { title: 'Spring all-day', start: '2026-03-08T00:00:00Z', end: '2026-03-09T00:00:00Z', all_day: true, possible_deals: [] },
    { title: 'Fall all-day', start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z', all_day: true, possible_deals: [] },
  ] });
  const zone = page.getByRole('combobox', { name: 'Meeting timezone', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Meeting preparation', exact: true });
  for (const [value, time, observed] of [
    ['America/New_York', '12:00 PM EDT', '10:00 AM EDT'],
    ['America/Chicago', '11:00 AM CDT', '9:00 AM CDT'],
    ['America/Denver', '10:00 AM MDT', '8:00 AM MDT'],
    ['America/Los_Angeles', '9:00 AM PDT', '7:00 AM PDT'],
    ['UTC', '4:00 PM UTC', '2:00 PM UTC'],
  ]) {
    await zone.selectOption(value);
    await page.getByRole('button', { name: 'Prepare meetings', exact: true }).click();
    await settles(async () => assert.match(await dialog.innerText(), /Timed meeting/));
    assert.ok((await dialog.locator('article').filter({ hasText: 'Timed meeting' }).innerText()).includes(time));
    assert.ok((await dialog.innerText()).includes(observed));
    for (const [title, start, end] of [['Spring all-day', 'Mar 8', 'Mar 9'], ['Fall all-day', 'Nov 1', 'Nov 2']]) {
      const row = await dialog.locator('article').filter({ hasText: title }).innerText();
      assert.ok(row.includes(`${start} to ${end}`), `${value}: ${row}`);
      assert.match(row, /All day/);
    }
    await dialog.getByRole('button', { name: 'Close meeting preparation', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Meeting preparation opens possible deal context on demand at ${width}px ${theme}`, async t => {
  const { page, calls, errors, responses } = await open(t, { width, theme, calendar: { state: 'ready', items: [
    { start: '2026-10-01T16:00:00Z', title: 'Demo practice meeting', location: 'Demo office', attendee_count: 3, all_day: false },
  ] } });
  assert.equal(calls.includes('calendar-meeting-prep'), false, 'Home does not fetch preparation before it is requested');
  responses.set('calendar-meeting-prep', {
    state: 'partial', observed_at: '2026-10-01T14:00:00Z', notes: ['Check Outlook for cancellations.'],
    sources: { outlook_calendar: { state: 'stale' }, deal_suggestions: { state: 'ready' }, meeting_prep: { state: 'ready' } },
    items: [{ title: 'Demo lease review <script>', start: '2026-10-01T16:00:00Z', end: '2026-10-01T17:00:00Z', location: 'Demo office', all_day: false,
      schedule_conflict: true, time_changed: true, possible_deals: [
        { id: 'demo/deal?one', name: 'Demo lease <img>', prep: { state: 'ready', phase: 'Negotiation', next_step: 'Review counteroffer', next_date: '2026-11-02', last_touch: '2026-09-30', market: 'Demo City' } },
        { id: 'demo-other', name: 'Demo alternative', prep: { state: 'unavailable' } },
        { id: 'demo-missing', name: 'Demo missing facts', prep: { state: 'ready', phase: null, next_step: null, next_date: null, last_touch: null, market: null } },
      ] }],
  });
  await page.getByRole('button', { name: 'Prepare meetings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Meeting preparation', exact: true });
  await settles(async () => assert.match(await dialog.innerText(), /Review counteroffer/));
  const text = await dialog.innerText();
  for (const value of ['Possible deals', 'not confirmed', 'Demo lease review <script>', 'Demo lease <img>', 'Negotiation', '2026-11-02', '2026-09-30', 'Demo City', 'Preparation unavailable', 'Check Outlook for cancellations.', 'stale', 'Overlapping meetings', 'Time changed']) assert.ok(text.includes(value), value);
  assert.equal(await dialog.getByRole('link', { name: 'Demo lease <img>', exact: true }).getAttribute('href'), '/deals?deal=demo%2Fdeal%3Fone');
  assert.equal(await dialog.locator('script,img').count(), 0);
  assert.equal(await dialog.getByText('Not recorded', { exact: true }).count(), 5);
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  await screenshot(page, `meeting-preparation-detail-${width}-${theme}`);
  await dialog.getByRole('button', { name: 'Close meeting preparation', exact: true }).click();
  await settles(async () => assert.equal(await dialog.isVisible(), false));
  assert.equal(await page.getByRole('button', { name: 'Prepare meetings', exact: true }).evaluate(node => node === document.activeElement), true);
  assert.deepEqual(errors, []);
});


test('Meeting preparation distinguishes unavailable, malformed, partial and verified empty reads and retries', async t => {
  const { page, responses, errors } = await open(t, { calendar: prepCalendar });
  responses.set('calendar-meeting-prep', { then(_resolve, reject) { reject(Error('Synthetic outage')); } });
  await page.getByRole('button', { name: 'Prepare meetings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Meeting preparation', exact: true });
  await settles(async () => assert.match(await dialog.innerText(), /Meeting preparation unavailable/));
  for (const [value, expected] of [
    [{ state: 'empty', items: [null] }, /Meeting preparation unavailable/],
    [{ state: 'unavailable', items: [], notes: ['Demo calendar source unavailable.'] }, /Demo calendar source unavailable/],
    [{ state: 'partial', items: [], notes: ['Some stored meetings could not be shown.'] }, /No meetings returned/],
    [{ state: 'partial', notes: [], sources: { deal_suggestions: { state: 'unavailable' } }, items: [{ title: 'Demo unmatched meeting', start: '2026-10-01T16:00:00Z', end: '2026-10-01T17:00:00Z', possible_deals: [] }] }, /Possible deals unavailable/],
    [{ state: 'empty', items: [], notes: [] }, /No upcoming meetings/],
  ]) {
    responses.set('calendar-meeting-prep', value);
    await dialog.getByRole('button', { name: 'Refresh preparation', exact: true }).click();
    await settles(async () => assert.match(await dialog.innerText(), expected));
    if (value.state !== 'empty' || value.items.length) assert.doesNotMatch(await dialog.innerText(), /No upcoming meetings/);
  }
  assert.deepEqual(errors, []);
});

for (const retire of ['close', 'session']) test(`Meeting preparation fences late results after ${retire}`, async t => {
  const { page, responses, errors } = await open(t, { calendar: prepCalendar });
  let release;
  responses.set('calendar-meeting-prep', new Promise(resolve => { release = resolve; }));
  t.after(() => release({ state: 'empty', items: [] }));
  await page.getByRole('button', { name: 'Prepare meetings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Meeting preparation', exact: true });
  await settles(async () => assert.match(await dialog.innerText(), /Loading meeting preparation/));
  if (retire === 'close') await page.keyboard.press('Escape');
  else await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  await settles(async () => assert.equal(await dialog.isVisible(), false));
  const oldResult = { state: 'partial', items: [], notes: ['Demo retired private preparation'] };
  release(oldResult);
  await page.waitForTimeout(50);
  assert.doesNotMatch(await page.locator('body').textContent(), /Demo retired private preparation/);
  if (retire === 'close') {
    responses.set('calendar-meeting-prep', { state: 'empty', items: [] });
    await page.getByRole('button', { name: 'Prepare meetings', exact: true }).click();
    await settles(async () => assert.match(await dialog.innerText(), /No upcoming meetings/));
    assert.doesNotMatch(await dialog.innerText(), /Demo retired private preparation/);
  } else assert.equal(await page.locator('#homeMeetings').textContent(), '');
  assert.deepEqual(errors, []);
});


test('Meeting preparation clears protected content after an authorization refusal', async t => {
  const { page, responses, errors } = await open(t, { calendar: prepCalendar });
  await page.getByRole('button', { name: 'Prepare meetings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Meeting preparation', exact: true });
  await settles(async () => assert.match(await dialog.innerText(), /Demo practice planning/));
  responses.set('calendar-meeting-prep', { then(_resolve, reject) { reject(Object.assign(Error('Synthetic refusal'), { status: 403 })); } });
  await dialog.getByRole('button', { name: 'Refresh preparation', exact: true }).click();
  await settles(async () => assert.equal(await dialog.isVisible(), false));
  assert.doesNotMatch(await page.locator('body').textContent(), /Demo practice planning/);
  assert.deepEqual(errors, []);
});


for (const calendar of [{ state: 'empty', items: [] }, null]) test(`Meeting preparation restores current Home entry focus after calendar ${calendar ? 'repaint' : 'removal'}`, async t => {
  const { page, errors } = await open(t, { calendar: prepCalendar });
  await page.getByRole('button', { name: 'Prepare meetings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Meeting preparation', exact: true });
  await settles(async () => assert.match(await dialog.innerText(), /Demo practice planning/));
  await page.evaluate(calendar => document.dispatchEvent(new CustomEvent('doctorcre:brief-calendar', { detail: calendar })), calendar);
  await dialog.getByRole('button', { name: 'Close meeting preparation', exact: true }).click();
  const target = calendar ? page.getByRole('button', { name: 'Prepare meetings', exact: true }) : page.locator('#homePrimaryAction');
  await settles(async () => assert.equal(await target.evaluate(button => button === document.activeElement), true));
  assert.deepEqual(errors, []);
});

test('Your brief stays visible across Home visits', async t => {
  const { page } = await open(t, { tasksOnly: true, freshBrief: true });
  const brief = page.getByRole('complementary', { name: 'Your brief' });
  await brief.getByText('Demo follow-up').first().waitFor();
  const titles = await brief.locator('a').allTextContents();
  assert.ok(titles.length > 0);
  assert.equal(await page.locator('#docMorningBrief[open]').count(), 0);
  await page.reload();
  await brief.getByText('Demo follow-up').first().waitFor();
  assert.deepEqual(await brief.locator('a').allTextContents(), titles);
  assert.equal(await page.locator('#docMorningBrief[open]').count(), 0);

});

test('Your brief shows loading while the first task read is pending', async t => {
  const { page } = await open(t, { hangDetails: true });
  const brief = page.locator('#homeBrief');
  await brief.getByText('Updating tasks…').waitFor();
  assert.doesNotMatch(await brief.innerText(), /Tasks unavailable/);
});

test('Your brief shows unavailable after the task read fails', async t => {
  const { page } = await open(t, { malformedBoard: true });
  const brief = page.locator('#homeBrief');
  await brief.getByText('Tasks unavailable').waitFor();
  assert.doesNotMatch(await brief.innerText(), /\d+ open/);
});

test('Your brief does not claim zero open tasks when the list is partial', async t => {
  const { page } = await open(t, { emptyAgenda: true, initialDetailFailure: 'partial' });
  const brief = page.locator('#homeBrief');
  await brief.getByText('Some tasks unavailable').waitFor();
  assert.doesNotMatch(await brief.innerText(), /0 open/);
});

test('Your brief shows zero open tasks when the list is complete', async t => {
  const { page } = await open(t, { emptyAgenda: true });
  const brief = page.locator('#homeBrief');
  await brief.getByText('No open tasks').waitFor();
  assert.match(await brief.innerText(), /0 open/);
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) test(`H03 working week opens every dated item and restores focus at ${width} ${theme}`, async t => {
  const calendar = { state: 'ready', items: [
    { title: 'Synthetic afternoon meeting', start: '2026-10-01T20:00:00Z', all_day: false, location: 'Synthetic meeting room', attendee_count: 3 },
    { title: 'Synthetic morning meeting', start: '2026-10-01T14:15:00Z', all_day: false, location: null, attendee_count: 1 },
    { title: 'Synthetic all-day meeting', start: '2026-10-03T00:00:00Z', all_day: true, location: null, attendee_count: 0 },
  ] };
  const { page, calls, errors } = await open(t, { width, theme, calendar });
  const panel = page.getByRole('region', { name: 'Calendar', exact: true });
  await panel.getByRole('button', { name: 'Synthetic morning meeting', exact: true }).waitFor();
  assert.match(await panel.innerText(), /America\/Chicago/);
  assert.match(await page.locator('#homeMeetings .home-meeting').filter({ hasText: 'Synthetic all-day meeting' }).innerText(), /Oct 3/);
  const thursday = panel.getByRole('region', { name: 'Thursday, October 1, 2026', exact: true });
  assert.deepEqual(await thursday.getByRole('button').filter({ hasText: 'Synthetic' }).evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), [
    'Synthetic morning meeting', 'Synthetic afternoon meeting',
  ]);
  assert.match(await thursday.innerText(), /9:15 AM CDT/);
  assert.match(await thursday.innerText(), /3:00 PM CDT/);
  assert.ok(await thursday.getByRole('button', { name: 'Demo follow-up', exact: true }).count());
  for (const title of ['Synthetic morning meeting', 'Synthetic afternoon meeting', 'Demo follow-up']) {
    const chip = thursday.getByRole('button', { name: title, exact: true }).first();
    await chip.focus(); await page.keyboard.press('Enter');
    const detail = page.getByRole('dialog', { name: title, exact: true });
    await detail.waitFor();
    if (title === 'Synthetic morning meeting') {
      assert.match(await detail.innerText(), /9:15 AM CDT/);
      assert.match(await detail.innerText(), /1 attendee/);
      assert.match(await detail.innerText(), /Place not provided/);
    } else if (title === 'Demo follow-up') {
      assert.doesNotMatch(await chip.innerText(), /All day/);
      assert.doesNotMatch(await detail.innerText(), /All day/);
      assert.match(await detail.getByRole('link', { name: 'Open deal', exact: true }).getAttribute('href'), /^\/deals\?deal=/);
    }
    await page.keyboard.press('Escape');
    await detail.waitFor({ state: 'hidden' });
    assert.equal(await chip.evaluate(node => node === document.activeElement), true);
  }
  if (width === 390) {
    const choice = panel.getByRole('button', { name: 'Saturday, October 3, 2026', exact: true });
    await choice.click();
    assert.equal(await choice.getAttribute('aria-pressed'), 'true');
    assert.match(await panel.locator('.home-week-selected-day').innerText(), /Saturday, October 3, 2026/);
  }
  const saturday = panel.getByRole('region', { name: 'Saturday, October 3, 2026', exact: true });
  const allDay = saturday.getByRole('button', { name: 'Synthetic all-day meeting', exact: true });
  await allDay.click();
  const detail = page.getByRole('dialog', { name: 'Synthetic all-day meeting', exact: true });
  assert.match(await detail.innerText(), /All day/);
  const dir = new URL('../out/test-artifacts/home-week/', import.meta.url);
  await mkdir(dir, { recursive: true });
  await detail.screenshot({ path: `${dir.pathname}detail-${width}-${theme}.png` });
  await detail.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await allDay.evaluate(node => node === document.activeElement), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(calls.some(name => /patch-|complete-|reschedule/.test(name)), false);
  assert.deepEqual(errors, []);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${dir.pathname}week-${width}-${theme}.png`, fullPage: true });
  await panel.screenshot({ path: `${dir.pathname}week-panel-${width}-${theme}.png` });
});

test('H03 calendar details retire on a replaced meeting snapshot and session loss', async t => {
  const meeting = { title: 'Synthetic temporary meeting', start: '2026-10-01T14:00:00Z', all_day: false, location: null, attendee_count: 2 };
  const state = await open(t, { calendar: { state: 'ready', items: [meeting] } });
  const { page } = state;
  const calendar = page.getByRole('region', { name: 'Calendar', exact: true });
  await calendar.getByRole('button', { name: meeting.title, exact: true }).click();
  const detail = page.getByRole('dialog', { name: meeting.title, exact: true });
  await detail.waitFor();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('doctorcre:brief-calendar', { detail: { state: 'empty', items: [] } })));
  await detail.waitFor({ state: 'hidden' });
  assert.equal(await calendar.getByRole('button', { name: meeting.title, exact: true }).count(), 0);
  assert.equal(await calendar.getByRole('region', { name: 'Thursday, October 1, 2026', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.evaluate(meeting => document.dispatchEvent(new CustomEvent('doctorcre:brief-calendar', { detail: { state: 'ready', items: [meeting] } })), meeting);
  await calendar.getByRole('button', { name: meeting.title, exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  await detail.waitFor({ state: 'hidden' });
  assert.equal(await calendar.getByRole('button', { name: meeting.title, exact: true }).count(), 0);
  assert.deepEqual(state.errors, []);
});

test('H03 phone keeps the chosen day through a meeting update', async t => {
  const meeting = { title: 'Synthetic Saturday meeting', start: '2026-10-03T15:00:00Z', all_day: false, location: null, attendee_count: 1 };
  const meetings = Array.from({ length: 8 }, (_, index) => ({ ...meeting, title: `${meeting.title} ${index}` }));
  const { page } = await open(t, { width: 390, calendar: { state: 'ready', items: meetings } });
  const panel = page.getByRole('region', { name: 'Calendar', exact: true });
  await panel.getByRole('button', { name: 'Saturday, October 3, 2026', exact: true }).click();
  const day = panel.getByRole('region', { name: 'Saturday, October 3, 2026', exact: true });
  const position = async () => {
    const outer = await panel.boundingBox(), inner = await day.boundingBox();
    assert.ok(inner.x >= outer.x && inner.x + inner.width <= outer.x + outer.width + 1, 'chosen day stays within Calendar width');
  };
  await position();
  await day.evaluate(node => { node.scrollTop = 120; });
  const previousScroll = await day.evaluate(node => node.scrollTop);
  assert.ok(previousScroll > 0, 'fixture has vertically scrollable day content');
  await page.evaluate(meetings => document.dispatchEvent(new CustomEvent('doctorcre:brief-calendar', { detail: { state: 'ready', items: meetings.map(item => ({ ...item, title: `Updated ${item.title}` })) } })), meetings);
  await position();
  assert.equal(await day.evaluate(node => node.scrollTop), previousScroll);
  assert.match(await panel.locator('.home-week-selected-day').innerText(), /Saturday, October 3, 2026/);
  assert.equal(await panel.getByRole('button', { name: 'Saturday, October 3, 2026', exact: true }).getAttribute('aria-pressed'), 'true');
  await panel.getByRole('region', { name: 'Sunday, October 4, 2026', exact: true }).evaluate(node => node.scrollIntoView({ block: 'nearest', inline: 'start' }));
  await settles(async () => assert.match(await panel.locator('.home-week-selected-day').innerText(), /Sunday, October 4, 2026/));
});

test('H03 task details close when both calendar sources become unavailable', async t => {
  const state = await open(t, { calendar: { state: 'unavailable', items: [] } });
  const { page } = state;
  const panel = page.getByRole('region', { name: 'Calendar', exact: true });
  await panel.getByRole('button', { name: 'Demo follow-up', exact: true }).first().click();
  const detail = page.getByRole('dialog', { name: 'Demo follow-up', exact: true });
  await detail.waitFor();
  state.failDetails('503');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  await detail.waitFor({ state: 'hidden' });
  assert.equal(await panel.getByRole('button', { name: 'Demo follow-up', exact: true }).count(), 0);
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) test(`H03 meeting timezone updates Home without changing commitments at ${width} ${theme}`, async t => {
  const calendar = { state: 'ready', items: [
    { title: 'Synthetic midnight meeting', start: '2026-10-02T05:30:00Z', all_day: false, location: 'Synthetic meeting room', attendee_count: 2 },
    { title: 'Synthetic later meeting', start: '2026-10-02T06:15:00Z', all_day: false, location: null, attendee_count: 1 },
    { title: 'Synthetic all-day commitment', start: '2026-10-03T00:00:00Z', all_day: true, location: null, attendee_count: 0 },
  ] };
  const { page, calls, errors } = await open(t, { width, height: width === 390 ? 844 : 1000, theme, calendar });
  const panel = page.getByRole('region', { name: 'Calendar', exact: true });
  await panel.getByRole('button', { name: 'Synthetic midnight meeting', exact: true }).waitFor();
  const zone = panel.getByRole('combobox', { name: 'Meeting timezone', exact: true });
  assert.equal(await zone.count(), 1);
  assert.equal(await zone.inputValue(), 'America/Chicago');
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  const sourceReads = () => calls.filter(name => ['read-home-agenda', 'morning-brief'].includes(name)).length;
  const reads = sourceReads();
  await zone.focus();
  await zone.selectOption('America/Los_Angeles');
  assert.equal(await zone.evaluate(node => node === document.activeElement), true);
  const thursday = panel.getByRole('region', { name: 'Thursday, October 1, 2026', exact: true });
  assert.deepEqual(await thursday.getByRole('button').filter({ hasText: 'Synthetic' }).evaluateAll(nodes => nodes.map(node => node.textContent)), [
    '10:30 PM PDTSynthetic midnight meeting', '11:15 PM PDTSynthetic later meeting',
  ]);
  assert.match(await page.locator('#homeMeetings .home-meeting').filter({ hasText: 'Synthetic midnight meeting' }).innerText(), /Oct 1, 10:30 PM PDT/);
  assert.equal(sourceReads(), reads);
  assert.ok(await thursday.getByRole('button', { name: 'Demo follow-up', exact: true }).count());
  const saturday = panel.getByRole('region', { name: 'Saturday, October 3, 2026', exact: true });
  assert.equal(await saturday.getByRole('button', { name: 'Synthetic all-day commitment', exact: true }).count(), 1);
  const chip = thursday.getByRole('button', { name: 'Synthetic midnight meeting', exact: true });
  await chip.focus();
  await page.keyboard.press('Enter');
  const detail = page.getByRole('dialog', { name: 'Synthetic midnight meeting', exact: true });
  await detail.waitFor();
  assert.match(await detail.innerText(), /Thursday, October 1, 2026 · 10:30 PM PDT/);
  const dir = new URL('../out/test-artifacts/home-timezone/', import.meta.url);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir.pathname}detail-${width}-${theme}.png` });
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'hidden' });
  assert.equal(await chip.evaluate(node => node === document.activeElement), true);
  await zone.selectOption('America/New_York');
  const friday = panel.getByRole('region', { name: 'Friday, October 2, 2026', exact: true });
  assert.match(await friday.getByRole('button', { name: 'Synthetic midnight meeting', exact: true }).innerText(), /1:30 AM EDT/);
  assert.match(await page.locator('#homeMeetings .home-meeting').filter({ hasText: 'Synthetic midnight meeting' }).innerText(), /Oct 2, 1:30 AM EDT/);
  assert.equal(sourceReads(), reads);
  await page.locator('#refreshHome').click();
  await page.waitForFunction(() => document.querySelector('#refreshHome').getAttribute('aria-busy') === 'false');
  assert.equal(await zone.inputValue(), 'America/New_York');
  assert.match(await friday.getByRole('button', { name: 'Synthetic midnight meeting', exact: true }).innerText(), /1:30 AM EDT/);
  if (width === 390) await panel.getByRole('button', { name: 'Friday, October 2, 2026', exact: true }).click();
  await panel.evaluate(node => { node.scrollIntoView({ block: 'start' }); window.scrollBy(0, -160); });
  await zone.focus();
  const bounds = await zone.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'timezone control fits the viewport');
  assert.equal(await zone.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'timezone label is not clipped');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${dir.pathname}home-${width}-${theme}.png` });
  await page.locator('#homeMeetings').evaluate(node => { node.scrollIntoView({ block: 'start' }); window.scrollBy(0, -160); });
  await page.screenshot({ path: `${dir.pathname}meetings-${width}-${theme}.png` });
  await page.reload();
  await panel.getByRole('button', { name: 'Synthetic midnight meeting', exact: true }).waitFor();
  assert.equal(await zone.inputValue(), 'America/Chicago', 'reload starts a new display choice');
  assert.equal(await page.locator('#docMorningBrief[open]').count(), 0);
  assert.deepEqual(errors, []);
});

test('Home downloads meeting confirmation only when the calendar returns reviews', async t => {
  const { page, errors, resources } = await open(t, { calendar: { state: 'empty', items: [], follow_up_reviews: [] } });
  await page.locator('#homeMeetings').getByText('No upcoming meetings', { exact: true }).waitFor();
  assert.equal(resources.includes('/js/home-meeting-reviews.js'), false);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('doctorcre:brief-calendar', { detail: {
    state: 'partial', items: [], notes: [], follow_up_reviews: [{ key: 'aaaaaaaaaaaaaaaa', state: 'needs_review', title: 'Demo lender meeting', start: '2026-10-01T13:00:00Z', end: '2026-10-01T14:00:00Z' }],
  } })));
  const panel = page.locator('#homeMeetingReviews');
  await panel.getByRole('heading', { name: 'Did these meetings happen?' }).waitFor();
  await panel.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
});

test('session loss during the meeting-confirmation download prevents late controls', async t => {
  const { page } = await open(t, { calendar: { state: 'empty', items: [], follow_up_reviews: [] } });
  await page.locator('#homeMeetings').getByText('No upcoming meetings', { exact: true }).waitFor();
  let release, requested;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requested = resolve; });
  t.after(() => release());
  await page.route('**/js/home-meeting-reviews.js', async route => {
    requested(); await gate;
    await route.fulfill({ body: await readFile(new URL('../js/home-meeting-reviews.js', import.meta.url)), contentType: 'text/javascript' });
  });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('doctorcre:brief-calendar', { detail: {
    state: 'partial', items: [], follow_up_reviews: [{ key: 'bbbbbbbbbbbbbbbb', state: 'needs_review', title: 'Demo retired meeting', start: '2026-10-01T13:00:00Z', end: '2026-10-01T14:00:00Z' }],
  } })));
  await started;
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  release();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#homeMeetingReviews').isVisible(), false);
  assert.equal(await page.getByText('Demo retired meeting', { exact: true }).count(), 0);
});

test('Deals panel ends with muted counts and a plain All deals link', async t => {
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    const { page } = await open(t, { width, theme });
    await screenshot(page, `deals-footer-${width}-${theme}`);
    const panel = page.locator('#dealAttention');
    const link = panel.getByRole('link', { name: 'All deals', exact: true });
    assert.equal(await link.getAttribute('href'), '/deals');
    assert.equal(await panel.locator('footer #dealCounts').isVisible(), true);
    assert.equal(await page.locator('main > footer #dealCounts').count(), 0);
    assert.equal(await link.evaluate(el => getComputedStyle(el).borderTopStyle), 'none');
  }
});
