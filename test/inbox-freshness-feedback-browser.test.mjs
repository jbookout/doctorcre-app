import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

describe('test/inbox-freshness-feedback-browser.test.mjs', () => {

let outDir;
before(async () => { outDir = await temporaryDirectory('doctorcre-inbox-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const row = (item_id, fields = {}) => ({ auto_settled: false, item_id, source_type: 'next_action', source_id: item_id, source_version: 'v1', source_state: 'needs_attention', title: `Synthetic ${item_id}`, activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', context_label: 'Demo practice with a long owning deal name', due_on: '2026-11-05', open_url: '/deals?deal=00000000-0000-0000-0000-000000000001&focus=next-step', kind_label: 'Task', merged_source_ids: ['00000000-0000-0000-0000-000000000002'], action_id: item_id === 'b' ? '00000000-0000-0000-0000-000000000003' : '00000000-0000-0000-0000-000000000002', action_version: 7, deal_id: '00000000-0000-0000-0000-000000000001', ...fields });
async function open(t, { width = 1440, theme = 'light', clock = false, extra = [], taskLost = null } = {}) {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Chicago' });
  page.setDefaultTimeout(10_000);
  if (clock) await page.clock.install({ time: new Date('2026-10-30T12:00:00Z') });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  const items = [row('a'), row('b', { source_state: 'needs_attention', unseen: true }), row('working', { source_state: 'working', section: 'working' }), ...extra];
  const taskReceipts = new Map();
  const calls = [];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-inbox' } }));
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } });
    calls.push({ name, args });
    let payload;
    if (name === 'read-home-inbox-v3') payload = { ok: true, schema_version: 'home-inbox.v3', truncated: false, limit: 1000, items, working_collapsed: true, auto_settle_enabled: true };
    else if (['complete-one-action', 'reopen-one-action'].includes(name)) {
      const prior = taskReceipts.get(args.idempotency_key);
      if (prior) payload = prior;
      else {
        const item = items.find(item => item.action_id === args.action_id);
        if (item.action_version !== args.base_version) payload = { ok: false, error: 'version_conflict' };
        else {
          const done = name === 'complete-one-action';
          Object.assign(item, { action_version: args.base_version + 1, source_state: done ? 'done' : 'needs_attention', section: done ? 'done' : 'inbox', base_version: `task:${args.base_version + 1}` });
          payload = { ok: true, action_id: args.action_id, version: item.action_version, status: done ? 'done' : 'open', completion_event_id: args.completion_event_id || '00000000-0000-0000-0000-000000000009' };
          taskReceipts.set(args.idempotency_key, payload);
          if (taskLost === name) { taskLost = null; return route.abort(); }
        }
      }
    }
    else payload = { ok: true, items: [], counts: {}, suggestions: [], enabled: false };
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/inbox?mode=live`);
  return { page, calls };
}

const reads = calls => calls.filter(call => call.name === 'read-home-inbox-v3').length;
async function focus(page) { await page.evaluate(() => { dispatchEvent(new Event('focus')); dispatchEvent(new Event('focus')); }); }
async function visible(page, state) { await page.evaluate(state => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: state }); document.dispatchEvent(new Event('visibilitychange')); }, state); }
test('focus refreshes once; visible clock refreshes every minute; hidden offline and retired views do not poll', async t => {
  const { page, calls } = await open(t, { clock: true });
  await page.locator('[data-inbox-row="a"]').waitFor();
  const initial = reads(calls);
  const focused = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postDataJSON()?.params?.name === 'read-home-inbox-v3');
  await focus(page);
  await (await focused).finished();
  await page.waitForFunction(() => !document.querySelector('.inbox-health').textContent.includes('Updating'));
  assert.equal(reads(calls), initial + 1, 'one returning-focus read');
  const interval = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postDataJSON()?.params?.name === 'read-home-inbox-v3');
  await page.clock.runFor(60_000);
  await (await interval).finished();
  await page.waitForFunction(() => !document.querySelector('.inbox-health').textContent.includes('Updating'));
  assert.equal(reads(calls), initial + 2, 'one visible interval read');
  await visible(page, 'hidden');
  await page.clock.runFor(120_000);
  assert.equal(reads(calls), initial + 2);
  await page.context().setOffline(true);
  await visible(page, 'visible');
  await page.clock.runFor(120_000);
  assert.equal(reads(calls), initial + 2);
  const reconnected = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postDataJSON()?.params?.name === 'read-home-inbox-v3');
  await page.context().setOffline(false);
  await reconnected;
  await page.waitForFunction(() => !document.querySelector('.inbox-health').textContent.includes('Updating'));
  assert.equal(reads(calls), initial + 3);
  await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  const retired = reads(calls);
  await page.clock.runFor(120_000); await focus(page);
  assert.equal(reads(calls), retired);
});
test('transient refresh failure retains readable cards, chosen focus and an open snooze choice', async t => {
  const { page, calls } = await open(t, { clock: true });
  const opener = page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Snooze', exact: true });
  await opener.click();
  await focus(page);
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('button', { name: /^1 hour/ }).evaluate(node => node === document.activeElement), true);
  await page.route('**/mcp', route => route.abort());
  await page.clock.runFor(60_000);
  await page.getByText('Update unavailable', { exact: false }).waitFor();
  assert.equal(await page.locator('[data-inbox-row="a"]').isVisible(), true);
  assert.equal(await page.getByRole('dialog').isVisible(), true);
  assert.equal(calls.some(call => /^(snooze|settle|complete|reopen)/.test(call.name)), false);
});
for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`expanded bulk controls clear fixed footer ${width} ${theme}`, async t => {
  const { page } = await open(t, { width, theme, extra: Array.from({ length: 14 }, (_, i) => row(`extra${i}`, { action_id: `00000000-0000-0000-0000-${String(100 + i).padStart(12, '0')}` })) });
  await page.getByLabel('Select Synthetic a', { exact: true }).check();
  await page.getByLabel('Select Synthetic b', { exact: true }).check();
  await page.locator('.inbox-bulk').scrollIntoViewIfNeeded();
  await page.evaluate(() => { document.querySelector('#appStatusSlot').textContent = 'Synthetic status'; scrollTo(0, 1000); });
  const bar = await page.locator('.inbox-bulk').boundingBox();
  const bottom = await page.evaluate(() => Math.min(innerHeight, ...[...document.querySelectorAll('.app-shell-header, .app-layout-status')].map(node => node.getBoundingClientRect()).filter(box => box.height && box.top > innerHeight / 2).map(box => box.top)));
  assert.ok(bar.y + bar.height <= bottom - 8, `bulk bottom ${bar.y + bar.height} clears footer ${bottom}`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mkdir('/tmp/WR39.S1.J64-evidence', { recursive: true });
  await page.screenshot({ path: `/tmp/WR39.S1.J64-evidence/bulk-${width}-${theme}.png` });
});
test('a delayed pre-Undo read cannot restore an old task version', async t => {
  const { page, calls } = await open(t, { clock: true });
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  let release; let requested;
  const waiting = new Promise(resolve => { requested = resolve; });
  let held = false;
  await page.route('**/mcp', async route => {
    if (route.request().postDataJSON().params.name !== 'read-home-inbox-v3' || held) return route.fallback();
    held = true; requested();
    await new Promise(resolve => { release = resolve; });
    const items = [row('a', { action_version: 8, source_state: 'done', section: 'done', base_version: 'task:8' }), row('b')];
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, schema_version: 'home-inbox.v3', truncated: false, limit: 1000, items, working_collapsed: true, auto_settle_enabled: true }) }] } } }).catch(() => {});
  });
  await focus(page); await waiting;
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Undone.', { exact: false }).waitFor();
  release();
  const a = page.locator('[data-inbox-row="a"]');
  await a.getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByText('Marked done: Synthetic a.', { exact: false }).waitFor();
  assert.equal(calls.filter(call => call.name === 'complete-one-action').at(-1).args.base_version, 9);
});
test('focus reads wait for a pending Undo without replaying it', async t => {
  const { page, calls } = await open(t, { clock: true });
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  let release; let requested;
  const waiting = new Promise(resolve => { requested = resolve; });
  await page.route('**/mcp', async route => {
    if (route.request().postDataJSON().params.name !== 'reopen-one-action') return route.fallback();
    requested(); await new Promise(resolve => { release = resolve; }); await route.fallback();
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await waiting;
  const before = reads(calls);
  await focus(page); await page.clock.runFor(6_000); await focus(page);
  assert.equal(reads(calls), before, 'no competing reads during Undo');
  release(); await page.getByText('Undone.', { exact: false }).waitFor();
  assert.equal(calls.filter(call => call.name === 'reopen-one-action').length, 1);
});
test('focus and reconnect retain an uncertain inverse until the exact explicit retry', async t => {
  const { page, calls } = await open(t, { clock: true, taskLost: 'reopen-one-action' });
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Result uncertain.', { exact: false }).waitFor();
  await page.clock.runFor(60_000); await focus(page);
  await page.context().setOffline(true); await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Retry same request' }).waitFor();
  assert.equal(calls.filter(call => call.name === 'reopen-one-action').length, 1);
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await page.getByText('Undone.', { exact: false }).waitFor();
  const attempts = calls.filter(call => call.name === 'reopen-one-action');
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
});
for (const isError of [true, false]) for (const code of ['invalid_completion', 'version_conflict', 'internal_secret_do_not_show']) test(`bounded human refusal for ${code}, envelope error ${isError}`, async t => {
  const { page } = await open(t);
  await page.route('**/mcp', route => route.request().postDataJSON().params.name === 'complete-one-action' ? route.fulfill({ json: { result: { isError, content: [{ type: 'text', text: JSON.stringify({ error: code, detail: 'private raw diagnostic'.repeat(1000) }) }] } } }) : route.fallback());
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByText(code === 'invalid_completion' ? 'This completion can no longer be undone.' : code === 'version_conflict' ? 'This card changed on the server.' : 'The server did not confirm this change.', { exact: false }).waitFor();
  const text = await page.locator('.inbox-notice').textContent();
  assert.ok(text.length < 400); assert.ok(!text.includes(code)); assert.ok(!text.includes('private raw diagnostic'));
});
test('authentication loss during a refresh retires all private cards', async t => {
  const { page } = await open(t);
  await page.locator('[data-inbox-row="a"]').waitFor();
  let refuse;
  const denial = new Promise(resolve => { refuse = resolve; });
  await page.route('**/mcp', async route => {
    await denial;
    await route.fulfill({ status: 401, json: { error: 'authentication_required' } });
  });
  const refresh = page.waitForRequest(request => request.url().endsWith('/mcp') && request.postDataJSON()?.params?.name === 'read-home-inbox-v5');
  await focus(page);
  await refresh;
  refuse();
  await page.waitForURL('**/public-shell/session-ended.html');
  await page.getByRole('heading', { name: 'Session ended', exact: true }).waitFor();
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Sign in again', exact: true }).isVisible(), true);
});
for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`receipt and chosen focus clear fixed footer ${width} ${theme}`, async t => {
  const { page } = await open(t, { width, theme, extra: Array.from({ length: 14 }, (_, i) => row(`extra${i}`, { action_id: `00000000-0000-0000-0000-${String(100 + i).padStart(12, '0')}` })) });
  await page.locator('[data-inbox-row="extra10"]').getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByText('Marked done: Synthetic extra10.', { exact: false }).waitFor();
  await page.waitForFunction(() => document.activeElement.closest('[data-inbox-row]')?.dataset.inboxRow === 'extra11');
  const notice = await page.locator('.inbox-notice').boundingBox();
  const undo = await page.getByRole('button', { name: 'Undo', exact: true }).boundingBox();
  const bottom = await page.evaluate(() => Math.min(innerHeight, ...[...document.querySelectorAll('.app-shell-header, .app-layout-status')].map(node => node.getBoundingClientRect()).filter(box => box.height && box.top > innerHeight / 2).map(box => box.top)));
  assert.ok(notice.y >= 60 && notice.y + notice.height < bottom);
  assert.ok(undo.y + undo.height < bottom);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `/tmp/WR39.S1.J64-evidence/receipt-${width}-${theme}.png` });
});

});
