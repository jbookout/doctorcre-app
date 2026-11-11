import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

let outDir;
before(async () => { outDir = await temporaryDirectory('inbox-workspace-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });
const title = 'Synthetic overdue lease with a long title for the single attention workspace';
const deal = { id: 'synthetic-deal', name: title, owner: 'joe', phase: 'legal', operating_state: 'active', next_step: 'Call synthetic owner', next_date: '2020-01-01' };
const item = { auto_settled: false, item_id: 'synthetic-action', source_type: 'next_action', source_id: 'synthetic-action', source_version: 'v1', source_state: 'needs_attention', title, activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', context_label: title, due_on: deal.next_date, open_url: null, kind_label: 'Task', merged_source_ids: [], action_id: '00000000-0000-0000-0000-000000000002', action_version: 1, deal_id: null };

async function open(t, { path = '/inbox', width = 1280, theme = 'light', saved = 'open', inboxError = false, pending = false } = {}) {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Chicago' });
  const binding = createHash('sha256').update(JSON.stringify(['joe', 'synthetic'])).digest('hex');
  await page.addInitScript(({ theme, path, saved, binding }) => {
    localStorage.setItem('doctorcre-session-binding-v1', binding);
    localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } }));
    localStorage.setItem(`doctorcre:sidebar:${path}`, saved);
    localStorage.setItem('doctorcre:today', saved);
  }, { theme, path, saved, binding });
  let signedOut = false;
  await page.route('**/auth/session', route => route.fulfill(signedOut ? { status: 401, json: { error: 'signed_out' } } : { json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/auth/signout', route => { signedOut = true; return route.fulfill({ status: 401, json: { error: 'signed_out' } }); });
  let releaseInbox;
  const inboxReady = pending ? new Promise(resolve => { releaseInbox = resolve; }) : Promise.resolve();
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  const calls = [];
  await page.route('**/mcp', async route => {
    const { name } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } }); calls.push(name);
    if (name === 'read-home-inbox-v3') await inboxReady;
    const today = { subject_type: 'deal', subject_id: deal.id, subject_name: title, what: deal.next_step, due_on: deal.next_date, owner_partner: 'joe' };
    const payload = name === 'deal-room-board' ? { actor: 'joe', deals: [deal] }
      : name === 'morning-brief' ? { sponsor: 'joe', sections: { today: { state: 'ready', items: [today] }, deals: { state: 'ready', items: [deal] }, loops: { state: 'empty', items: [] } } }
      : name === 'today-triage' ? { items: [today] }
      : name === 'read-home-inbox-v3' ? inboxError ? { ok: false, error: 'read_limit_exceeded' } : { ok: true, schema_version: 'home-inbox.v3', truncated: false, limit: 1000, items: [item], working_collapsed: true, auto_settle_enabled: true }
      : { ok: true, events: [], cursor: 'end', items: [], counts: {}, suggestions: [], enabled: false };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}${path}?mode=live`);
  await page.locator(path === '/vendors' ? '#appTodayNeeds [data-layout-deal]' : '#appWorkingList [data-layout-deal]').first().waitFor({ state: 'attached' });
  return { page, calls, releaseInbox };
}

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  for (const path of ['/inbox', '/inbox.html', '/inbox/card/synthetic-action']) {
    test(`one Inbox attention list at ${path}, ${width}, ${theme}`, async t => {
      const { page } = await open(t, { path, width, theme });
      await page.locator('[data-inbox-row="synthetic-action"]').waitFor();
      assert.equal(await page.locator('#appWorkingList [data-layout-deal="synthetic-deal"]').count(), 1, 'seeded overdue deal reaches the left list');
      if (width === 390) await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
      assert.equal(await page.locator('.app-layout-working').isVisible(), false, 'Inbox hides the left Overdue list');
      if (width === 390) await page.keyboard.press('Escape');
      if (width === 390) await page.getByRole('button', { name: 'Today sidebar', exact: true }).click();
      assert.equal(await page.locator('#appTodayNeeds').isVisible(), false, 'Inbox hides the repeated right Overdue list');
      assert.equal(await page.locator('#appScheduleSlot a').isVisible(), true);
      if (width === 390) {
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#appTodayToggle').evaluate(node => node === document.activeElement), true);
      }
      assert.equal(await page.getByRole('heading', { name: title, exact: true }).count(), 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (path === '/inbox') {
        await mkdir('test-artifacts/inbox-single-workspace', { recursive: true });
        await page.screenshot({ path: `test-artifacts/inbox-single-workspace/${width}-${theme}.png`, fullPage: true });
      }
    });
  }
}

test('Inbox respects closed sidebar preferences, opens Today by keyboard, and clears on sign-out', async t => {
  const { page } = await open(t, { saved: 'closed' });
  assert.equal(await page.locator('#appLayout').getAttribute('data-sidebar'), 'closed');
  assert.equal(await page.locator('#appLayout').getAttribute('data-today'), 'closed');
  await page.locator('#appTodayToggle').focus(); await page.keyboard.press('Enter');
  await page.locator('#appScheduleSlot a').waitFor();
  assert.equal(await page.locator('#appTodayNeeds').isVisible(), false);
  await page.locator('#selfAvatar').click();
  await page.locator('#accountSignOut').click();
  await page.locator('#appLayout').waitFor({ state: 'detached' });
  assert.equal(await page.getByText(title, { exact: true }).count(), 0);
});

test('Inbox loading preserves one workspace until its read resolves', async t => {
  const { page, releaseInbox } = await open(t, { width: 390, pending: true });
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
  await page.locator('#appTodayToggle').click();
  assert.equal(await page.locator('#appScheduleSlot a').isVisible(), true);
  assert.equal(await page.locator('#appTodayNeeds').isVisible(), false);
  await page.keyboard.press('Escape');
  releaseInbox();
  await page.locator('[data-inbox-row="synthetic-action"]').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test('Inbox read error keeps the same Calendar day treatment', async t => {
  const { page } = await open(t, { inboxError: true });
  await page.getByRole('alert').filter({ hasText: 'Inbox unavailable' }).waitFor();
  assert.equal(await page.locator('.app-layout-working').isVisible(), false);
  assert.equal(await page.locator('#appTodayNeeds').isVisible(), false);
  assert.equal(await page.locator('#appScheduleSlot a').isVisible(), true);
});

for (const path of ['/', '/deals', '/calendar', '/vendors']) test(`${path} retains its sidebar treatment`, async t => {
  const { page } = await open(t, { path });
  if (path === '/') {
    assert.equal(await page.locator('.app-layout-working').isVisible(), false);
    assert.equal(await page.locator('#appTodayNeeds').isVisible(), false);
    assert.equal(await page.locator('#appScheduleSlot a').count(), 1);
  } else {
    assert.equal(await page.locator('.app-layout-working').count(), path === '/vendors' ? 0 : 1);
    assert.equal(await page.locator('#appTodayNeeds [data-layout-deal="synthetic-deal"]').count(), 1);
    assert.equal(await page.locator('#appTodayNext [data-layout-deal="synthetic-deal"]').count(), 1);
  }
});
