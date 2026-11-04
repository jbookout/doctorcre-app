import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import axe from 'axe-core';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium, fixtureServer } from './browser-harness.mjs';
let outDir;
before(async () => { outDir = temporaryDirectory('home-sections-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => { await rm(outDir, { recursive: true, force: true }); });
for (const width of [390, 1024, 1280, 1440]) for (const theme of ['light', 'dark']) test(`sectioned Home and shared panels ${width} ${theme}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Chicago' });
  await page.clock.install({ time: new Date('2026-11-04T16:00:17Z') });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.goto(server.origin);
  await page.getByRole('heading', { name: 'Welcome home.' }).waitFor();
  for (const name of ['Needs your attention', 'Today', 'In motion and waiting', 'Done today', 'Earlier and undated completions']) assert.equal(await page.locator('main').getByRole('heading', { name: new RegExp(`^${name}`) }).count(), 1);
  await page.getByText('Nothing here right now.', { exact: true }).first().waitFor();
  const more = page.getByRole('region', { name: 'Needs your attention', exact: true }).getByRole('button', { name: /See all|Show less/ });
  await more.click(); assert.equal(await more.getAttribute('aria-expanded'), 'true');
  await more.click(); assert.equal(await more.getAttribute('aria-expanded'), 'false');

  const calendar = page.locator('#appSidebarToggle'); const today = page.locator('#appTodayToggle');
  if (width === 390) { assert.equal(await today.getAttribute('aria-expanded'), 'false'); await calendar.click(); }
  await page.locator('#appSidebar').getByRole('heading', { name: 'Your calendar' }).waitFor();
  await page.addScriptTag({ content: axe.source });
  assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations), []);
  await page.locator('#appSidebar').getByText('Demo practice planning', { exact: true }).waitFor();
  if (width === 390) await page.screenshot({ path: `/tmp/WR617.S14.J8-shots/calendar-drawer-${width}-${theme}.png`, fullPage: true });
  assert.equal(await page.locator('#appSidebar').getByRole('link', { name: 'Review call follow-ups ↗', exact: true }).isVisible(), false);
  if (width === 390) { await page.keyboard.press('Escape'); assert.equal(await calendar.evaluate(n => n === document.activeElement), true); await today.click(); }
  assert.equal(await today.getAttribute('aria-expanded'), 'true');
  await page.getByText('A LITTLE LOOK AHEAD', { exact: true }).waitFor();
  await page.locator('#appToday').getByText('Demo practice planning', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations), []);
  if (width === 390) await page.screenshot({ path: `/tmp/WR617.S14.J8-shots/today-drawer-${width}-${theme}.png`, fullPage: true });
  await page.locator('[data-layout-close="today"]').click(); assert.equal(await today.getAttribute('aria-expanded'), 'false');
  await today.click(); assert.equal(await today.getAttribute('aria-expanded'), 'true');
  if (width === 390) await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `/tmp/WR617.S14.J8-shots/home-${width}-${theme}.png`, fullPage: true });
  await page.goto(`${server.origin}/calendar`);
  await page.locator('#appToday').getByText('A LITTLE LOOK AHEAD', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await today.getAttribute('aria-expanded'), width === 390 ? 'false' : 'true');
  assert.equal(await page.locator('#appSidebar .app-layout-working').count(), 0);
  assert.equal(await page.locator('#appSidebar [data-layout-slot=sidebar]').count(), 0);
  await page.screenshot({ path: `/tmp/WR617.S14.J8-shots/calendar-${width}-${theme}.png`, fullPage: true });
});

for (const state of ['empty', 'unavailable', 'partial']) test(`Home and schedule keep truthful ${state} states`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    if (name === 'read-home-inbox-v4') return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } });
    const payload = name === 'read-home-inbox-v3' ? { ok: true, schema_version: 'home-inbox.v3', truncated: false, limit: 1000, items: [], working_collapsed: true, auto_settle_enabled: true }
      : name === 'calendar-meeting-prep' ? { state, items: [] }
      : name === 'deal-room-board' ? { actor: 'joe', deals: [] }
      : { items: [], events: [], cursor: 'end' };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  await page.getByRole('heading', { name: 'Welcome home.' }).waitFor();
  await page.locator('main').getByText('Nothing here right now.', { exact: true }).first().waitFor();
  assert.equal(await page.locator('main').getByText('Nothing here right now.', { exact: true }).count(), 6);
  await page.locator('#appScheduleSlot').getByText(state === 'unavailable' ? 'Schedule unavailable. Refresh to try again.' : state === 'partial' ? 'No meetings returned for today.' : 'No meetings scheduled today.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
});

for (const fragment of ['homeCallTasks', 'homeEmailFollowups', 'homeOverdueReviews', 'homeBrief', 'homeReplyOutcomes']) test(`legacy Home bookmark ${fragment}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.origin}/?review=2#${fragment}`);
  await page.waitForURL(`**/review-workflows?review=2#${fragment}`, { timeout: 5000 });
  await page.locator(`#${fragment}`).waitFor({ state: 'attached' });
});

test('Calendar rail leaves page tools in the center at narrow desktop sizes', async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  for (const width of [1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`${server.origin}/calendar`);
    await page.locator('#appCalendarSlot a').first().waitFor();
    assert.equal(await page.locator('#appSidebar .app-layout-working, #appSidebar [data-layout-slot=sidebar], #appSidebar .calendar-panel-followup').count(), 0);
    assert.equal(await page.locator('#appMainSlot .app-layout-page-tools').count(), 1);
    assert.ok(await page.locator('#appSidebar').evaluate(node => node.scrollHeight <= node.clientHeight));
  }
});

for (const outcome of ['empty', 'unavailable']) test(`Home reserves its frame and defers panels until the ${outcome} inbox paints`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let release; const pending = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const panelReads = [];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', async route => {
    const { name } = route.request().postDataJSON().params;
    if (name === 'read-home-inbox-v4') return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } });
    if (name === 'read-home-inbox-v3') await pending;
    else panelReads.push(name);
    const value = name === 'read-home-inbox-v3' ? outcome === 'empty'
      ? { ok: true, schema_version: 'home-inbox.v3', truncated: false, limit: 1000, items: [], working_collapsed: true, auto_settle_enabled: true }
      : { ok: false, error: 'synthetic_unavailable' }
      : name === 'calendar-meeting-prep' ? { state: 'empty', items: [] }
      : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Loading your inbox…', { exact: true }).waitFor();
  await page.locator('#appSidebarToggle').waitFor();
  assert.deepEqual(panelReads, []);
  release();
  await page.locator('#appScheduleSlot').getByText('No meetings scheduled today.', { exact: true }).waitFor();
  assert.ok(panelReads.includes('calendar-meeting-prep'));
  await page.getByText(outcome === 'empty' ? 'Nothing here right now.' : 'Inbox unavailable', { exact: true }).first().waitFor();
});

test('a session ending during the assistant download prevents a late mount', async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  let release; const pending = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await page.route('**/js/doc-presence.js', async route => {
    const response = await route.fetch();
    await pending;
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__assistantModuleReady = true;` });
  });
  await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
  await page.locator('.home-slice [data-inbox-row]').first().waitFor();
  await page.locator('#appSidebarToggle').waitFor();
  await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  release();
  await page.waitForFunction(() => window.__assistantModuleReady);
  assert.equal(await page.locator('#docPresence').count(), 0);
});

test('late automatic Home walkthrough preserves an open account menu', async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  let release; const pending = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', route => route.fulfill({ json: { result: { content: [{ type: 'text', text: '{}' }] } } }));
  await page.route('**/js/doc-presence.js', async route => {
    const response = await route.fetch();
    await pending;
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__assistantModuleReady = true;` });
  });
  await page.goto(`${server.origin}/?mode=live`, { waitUntil: 'domcontentloaded' });
  const account = page.getByRole('button', { name: 'Joe: account and settings', exact: true });
  await account.click();
  assert.equal(await page.locator('#accountMenu').isVisible(), true);
  release();
  await page.waitForFunction(() => window.__assistantModuleReady && document.getElementById('docOpen'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#accountMenu').isVisible(), true);
  assert.equal(await page.locator('[data-walkthrough]').count(), 0);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`Done today evidence ${width} ${theme}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Chicago' });
  await page.clock.install({ time: new Date('2026-11-04T16:00:17Z') });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  const item = (item_id, completed_at, fields = {}) => ({ item_id, completed_at, source_type: 'next_action', source_id: item_id, source_version: 'v1', source_state: 'done', title: item_id, activity_at: '2026-11-04T16:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'done', base_version: 'v1', context_label: 'Demo practice', due_on: null, open_url: null, kind_label: 'Task', merged_source_ids: [], action_id: '00000000-0000-0000-0000-000000000001', action_version: 7, deal_id: null, auto_settled: false, ...fields });
  const items = [item('Finished after midnight', '2026-11-04T06:10:00Z', { section: 'settled', disposition: 'settled', auto_settled: true }), item('Yesterday with a new notification', '2026-11-04T05:30:00Z'), item('Legacy completed task', null), item('Manually hidden task', null, { source_state: 'needs_attention', disposition: 'settled', section: 'settled' })];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    const value = name === 'read-home-inbox-v4' ? { ok: true, schema_version: 'home-inbox.v4', truncated: false, limit: 1000, items, working_collapsed: true, auto_settle_enabled: true } : name === 'calendar-meeting-prep' ? { state: 'empty', items: [] } : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  const today = page.getByRole('region', { name: 'Done today', exact: true });
  await today.getByText('Finished after midnight', { exact: true }).waitFor();
  assert.equal(await today.locator('[data-inbox-row]').count(), 1);
  assert.equal(await today.getByText('Yesterday with a new notification', { exact: true }).count(), 0);
  await today.getByText('Done Nov 4, 2026, 12:10 AM CST', { exact: true }).waitFor();
  const earlier = page.getByRole('region', { name: 'Earlier and undated completions', exact: true });
  await earlier.getByRole('button', { name: 'See all 2' }).click();
  await earlier.getByText('Done, time not recorded', { exact: true }).waitFor();
  const hidden = page.getByRole('region', { name: 'Hidden from inbox', exact: true });
  await hidden.getByText('Manually hidden task', { exact: true }).waitFor();
  await hidden.getByText('Hidden from inbox by you', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `/tmp/WR617.S14.J8-shots/done-today-${width}-${theme}.png`, fullPage: true });
  await page.clock.fastForward(14 * 60 * 60 * 1000 - 18_000);
  assert.equal(await today.locator('[data-inbox-row]').count(), 1);
  await page.clock.fastForward(1000);
  assert.equal(await today.locator('[data-inbox-row]').count(), 0);
});
