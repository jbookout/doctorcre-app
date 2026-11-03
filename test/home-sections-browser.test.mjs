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
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.goto(server.origin);
  await page.getByRole('heading', { name: 'Welcome home.' }).waitFor();
  for (const name of ['Needs your attention', 'Today', 'In motion and waiting', 'Recently done']) assert.equal(await page.locator('main').getByRole('heading', { name: new RegExp(`^${name}`) }).count(), 1);
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
  if (width === 390) await page.screenshot({ path: `/tmp/wr617-s1-j23-shots/calendar-drawer-${width}-${theme}.png`, fullPage: true });
  assert.equal(await page.locator('#appSidebar').getByRole('link', { name: 'Review call follow-ups ↗', exact: true }).isVisible(), false);
  if (width === 390) { await page.keyboard.press('Escape'); assert.equal(await calendar.evaluate(n => n === document.activeElement), true); await today.click(); }
  assert.equal(await today.getAttribute('aria-expanded'), 'true');
  await page.getByText('A LITTLE LOOK AHEAD', { exact: true }).waitFor();
  await page.locator('#appToday').getByText('Demo practice planning', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations), []);
  if (width === 390) await page.screenshot({ path: `/tmp/wr617-s1-j23-shots/today-drawer-${width}-${theme}.png`, fullPage: true });
  await page.locator('[data-layout-close="today"]').click(); assert.equal(await today.getAttribute('aria-expanded'), 'false');
  await today.click(); assert.equal(await today.getAttribute('aria-expanded'), 'true');
  if (width === 390) await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `/tmp/wr617-s1-j23-shots/home-${width}-${theme}.png`, fullPage: true });
  await page.goto(`${server.origin}/calendar`);
  await page.locator('#appToday').getByText('A LITTLE LOOK AHEAD', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await today.getAttribute('aria-expanded'), width === 390 ? 'false' : 'true');
  assert.equal(await page.locator('#appSidebar .app-layout-working').count(), 0);
  assert.equal(await page.locator('#appSidebar [data-layout-slot=sidebar]').count(), 0);
  await page.screenshot({ path: `/tmp/wr617-s1-j23-shots/calendar-${width}-${theme}.png`, fullPage: true });
});

for (const state of ['empty', 'unavailable', 'partial']) test(`Home and schedule keep truthful ${state} states`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    const payload = name === 'read-home-inbox-v2' ? { ok: true, schema_version: 'home-inbox.v2', truncated: false, limit: 1000, items: [], working_collapsed: true, auto_settle_enabled: false }
      : name === 'calendar-meeting-prep' ? { state, items: [] }
      : name === 'deal-room-board' ? { actor: 'joe', deals: [] }
      : { items: [], events: [], cursor: 'end' };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  await page.getByRole('heading', { name: 'Welcome home.' }).waitFor();
  await page.locator('main').getByText('Nothing here right now.', { exact: true }).first().waitFor();
  assert.equal(await page.locator('main').getByText('Nothing here right now.', { exact: true }).count(), 5);
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
