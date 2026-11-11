import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import axe from 'axe-core';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

let outDir;
before(async () => { outDir = await temporaryDirectory('doctorcre-inbox-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const row = (item_id, fields = {}) => ({ auto_settled: false, item_id, source_type: 'next_action', source_id: item_id, source_version: 'v1', source_state: 'needs_attention', title: `Synthetic ${item_id}`, activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', context_label: 'Demo practice with a long owning deal name', due_on: '2026-11-05', open_url: '/deals?deal=00000000-0000-0000-0000-000000000001&focus=next-step', kind_label: 'Task', merged_source_ids: ['00000000-0000-0000-0000-000000000002'], action_id: item_id === 'b' ? '00000000-0000-0000-0000-000000000003' : '00000000-0000-0000-0000-000000000002', action_version: 7, deal_id: '00000000-0000-0000-0000-000000000001', ...fields });
async function open(t, { refusal = false, width = 1440, theme = 'light', card = '', partial = false, uncertain = false, holdUntil = null, clock = false, extra = [], malformed = false, intervening = null, legacy = false, taskLost = null, taskConflict = false } = {}) {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Chicago' });
  page.setDefaultTimeout(10_000);
  if (clock) await page.clock.install({ time: new Date('2026-10-30T12:00:00Z') });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  const items = [row('a', { hold_until: holdUntil }), row('b', { source_state: 'needs_attention', unseen: true }), row('working', { source_state: 'working', section: 'working' }), ...extra];
  if (malformed) delete items[0].action_version;
  const taskReceipts = new Map(); const taskCalls = [];
  const calls = []; let writes = 0; let originalReceipt;
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-inbox' } }));
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } });
    calls.push({ name, args });
    let payload;
    if (name === 'read-home-inbox-v3') payload = refusal ? { ok: false, error: 'read_limit_exceeded' } : { ok: true, schema_version: 'home-inbox.v3', truncated: false, limit: 1000, items, working_collapsed: true, auto_settle_enabled: true };
    else if (['complete-one-action', 'reopen-one-action'].includes(name)) {
      taskCalls.push({name, args});
      const prior = taskReceipts.get(args.idempotency_key);
      if (prior) payload = prior;
      else {
        const item = items.find(item => item.action_id === args.action_id);
        if (taskConflict && name === 'reopen-one-action') item.action_version += 2;
        if (item.action_version !== args.base_version) payload = { ok: false, error: 'version_conflict' };
        else {
          const done = name === 'complete-one-action';
          Object.assign(item, { action_version: args.base_version + 1, source_state: done ? 'done' : 'needs_attention', auto_settled: done, disposition: done ? 'settled' : 'inbox', section: done ? 'settled' : 'inbox', base_version: `task:${args.base_version + 1}` });
          payload = { ok: true, action_id: args.action_id, version: item.action_version, status: done ? 'done' : 'open', ...(!legacy ? { completion_event_id: args.completion_event_id || '00000000-0000-0000-0000-000000000009' } : {}) };
          taskReceipts.set(args.idempotency_key, payload);
          if (taskLost === name) { taskLost = null; return route.abort(); }
        }
      }
    }
    else if (!name.endsWith('-home-inbox')) payload = { ok: true, items: [], counts: {}, suggestions: [], enabled: false };
    else {
      writes++;
      if (uncertain && !intervening && writes === 1) return route.abort();
      payload = originalReceipt || { ok: true, schema_version: 'home-inbox-command.v1', results: args.items.map(({ item_id }) => {
        if (partial && item_id === 'b') return { item_id, ok: false, error: 'version_conflict', current_version: 'v9' };
        const item = items.find(item => item.item_id === item_id);
        Object.assign(item, { disposition: name.startsWith('unsettle') ? 'inbox' : name.startsWith('snooze') ? 'snoozed' : 'settled', snoozed_until: args.until || null, base_version: `opaque:${writes + 1}` });
        item.section = item.disposition !== 'inbox' ? item.disposition : item.source_state === 'working' ? 'working' : 'inbox';
        const receipt = structuredClone(item);
        if (intervening) Object.assign(item, { base_version: 'later:3', ...(intervening === 'snooze' ? { disposition: 'snoozed', section: 'snoozed', snoozed_until: '2099-01-01T00:00:00Z' } : { title: 'Edited elsewhere', source_version: 'v2', action_version: 8, context_label: 'New deal', due_on: '2026-11-06' }) });
        return { item_id, ok: true, item: receipt };
      }) };
      if (intervening) originalReceipt = payload;
      if (uncertain && intervening && writes === 1) return route.abort();
    }
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/inbox${card ? `/card/${card}` : ''}?mode=live`);
  return { page, calls };
}
test('The selected Working card opens in its shelf without an Unseen filter', async t => {
  const { page, calls } = await open(t, { card: 'working' });
  await page.getByRole('heading', { name: 'Synthetic working', exact: true }).waitFor();
  assert.equal(await page.locator('details[open]').count(), 1);
  assert.equal(await page.locator('[data-inbox-row]').count(), 3);
  assert.equal(await page.getByText('Unseen', { exact: true }).count(), 0);
  assert.equal(calls.filter(call => call.name === 'read-home-inbox-v3').length, 1);
  assert.deepEqual(calls.filter(call => ['read-home-agenda', 'get-deal-room'].includes(call.name)), [], 'The inbox reads no agenda and no per-card records');
});
test('settle and snooze have reversible Undo, and focus returns to a reachable row', async t => {
  const { page } = await open(t);
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Hide from inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.getByRole('button', { name: /^1 hour/ }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Hide from inbox', exact: true }).waitFor();
  assert.equal(await page.locator('details[open]').count(), 0);
  await page.waitForFunction(() => document.activeElement.closest('[data-inbox-row]') !== null);
});
test('partial bulk failure keeps failed card and retry preserves key and arguments', async t => {
  const { page, calls } = await open(t, { partial: true });
  await page.getByLabel('Select Synthetic a', { exact: true }).check();
  await page.getByLabel('Select Synthetic b', { exact: true }).check();
  await page.getByRole('button', { name: 'Hide selected', exact: true }).click();
  await page.getByText('This card changed on the server.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await page.getByText('This card changed on the server.', { exact: false }).waitFor();
  await page.waitForTimeout(60);
  const writes = calls.filter(call => call.name === 'settle-home-inbox');
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(await page.locator('[data-inbox-row="b"]').isVisible(), true);
});
test('uncertain outcome never moves card; manual retry reuses exact request; offline sends nothing', async t => {
  const { page, calls } = await open(t, { uncertain: true });
  const settle = page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Hide from inbox', exact: true });
  await settle.click(); await page.getByRole('button', { name: 'Retry same request' }).waitFor();
  assert.equal(await settle.isVisible(), true);
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  assert.deepEqual(calls.filter(call => call.name === 'settle-home-inbox')[0], calls.filter(call => call.name === 'settle-home-inbox')[1]);
  await page.context().setOffline(true);
  await page.locator('[data-inbox-row="b"]').getByRole('button', { name: 'Hide from inbox', exact: true }).click();
  await page.getByText('Offline.', { exact: false }).first().waitFor();
  assert.equal(calls.filter(call => call.name === 'settle-home-inbox').length, 2);
});
test('read refusal shows error instead of empty', async t => {
  const { page } = await open(t, { refusal: true });
  await page.getByRole('alert').filter({ hasText: 'Inbox unavailable' }).waitFor();
  assert.equal(await page.getByText('You’re all caught up.', { exact: true }).count(), 0);
});
for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`inbox evidence ${width} ${theme}`, async t => {
  const { page } = await open(t, { width, theme });
  await page.locator('[data-inbox-row="a"]').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mkdir('test-artifacts/home-inbox', { recursive: true });
  await page.screenshot({ path: `test-artifacts/home-inbox/${width}-${theme}.png`, fullPage: true });
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => (await window.axe.run(document.getElementById('homeRoot'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations);
  assert.deepEqual(violations, []);
});

test('keyboard movement and phone swipes act on the selected card; un-settle has Undo', async t => {
  const { page } = await open(t, { width: 390 });
  const first = page.locator('[data-inbox-row="a"] h3 a');
  await first.focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('[data-inbox-row="b"] h3 a').evaluate(node => node === document.activeElement), true);
  await page.locator('[data-inbox-row="a"]').evaluate(node => {
    const touch = x => new Touch({ identifier: 1, target: node, clientX: x, clientY: 100 });
    node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(100)] }));
    node.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [touch(220)] }));
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  await page.getByText('Settled', { exact: true }).click();
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Show in inbox', exact: true }).click();
  await page.locator('section[aria-label="Inbox"] [data-inbox-row="a"]').waitFor();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('details [data-inbox-row="a"]').waitFor();
});

test('undoing one bulk result keeps the Undo for every other confirmed card', async t => {
  const { page, calls } = await open(t);
  await page.getByLabel('Select Synthetic a', { exact: true }).check();
  await page.getByLabel('Select Synthetic b', { exact: true }).check();
  await page.getByRole('button', { name: 'Hide selected', exact: true }).click();
  await page.getByRole('button', { name: 'Undo Synthetic a', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Undo Synthetic a', exact: true }).click();
  const undoB = page.getByRole('button', { name: /^Undo( Synthetic b)?$/ });
  await undoB.waitFor();
  assert.equal(await page.getByRole('button', { name: /^Undo/ }).count(), 1, 'only the remaining card keeps an Undo');
  await undoB.click();
  await page.getByText(/1 confirmed/).waitFor();
  const unsettles = calls.filter(call => call.name === 'unsettle-home-inbox').map(call => call.args.items.map(item => item.item_id));
  assert.deepEqual(unsettles, [['a'], ['b']], 'each Undo reverses its own card once');
  assert.equal(await page.getByRole('button', { name: /^Undo/ }).count(), 0, 'an undo is not itself offered for undo');
});

test('date-only task holds keep the recorded day in the partner timezone', async t => {
  const { page } = await open(t, { holdUntil: '2026-10-30' });
  const row = page.locator('[data-inbox-row="a"]'); await row.waitFor();
  assert.match(await row.textContent(), /On hold until 2026-10-30/);
});

test('a command receipt does not make an old inbox snapshot look fresh', async t => {
  const { page } = await open(t, { clock: true });
  await page.locator('[data-inbox-row="a"]').waitFor();
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(91_000);
  await page.getByText('Snapshot may be stale', { exact: false }).waitFor();
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Hide from inbox', exact: true }).click();
  await page.getByText('1 confirmed.', { exact: false }).waitFor();
  assert.match(await page.locator('.inbox-health').textContent(), /Snapshot may be stale/);
});

test('opening a card preserves its section, count and keyboard focus', async t => {
  const { page } = await open(t);
  const section = page.locator('section[aria-label="Inbox"]');
  const link = section.locator('[data-inbox-row="a"] h3 a');
  await link.focus();
  const count = await section.locator('h2 span').textContent();
  await page.keyboard.press('Enter');
  await page.waitForURL(/inbox\/card\/a/);
  assert.equal(await section.locator('[data-inbox-row="a"]').count(), 1);
  assert.equal(await section.locator('h2 span').textContent(), count);
  assert.equal(await link.evaluate(node => node === document.activeElement), true);
});

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`v2 context and selected shelves ${width} ${theme}`, async t => {
  const title = 'Review the full task instructions and preserve this long title when opened. '.repeat(9);
  const { page } = await open(t, { width, theme, extra: [
    row('held', { title, section: 'held', hold_until: '2099-01-01' }),
    row('done', { source_state: 'done', section: 'done' }),
    row('loop', { source_type: 'notification', kind_label: 'Update', action_id: null, action_version: null, deal_id: null, context_label: 'Demo loop context', open_url: '/unsupported-page' }),
  ] });
  await page.getByText('Held', { exact: true }).click();
  const held = page.locator('[data-inbox-row="held"]');
  const link = held.locator('h3 a');
  await link.focus(); await page.keyboard.press('Enter');
  await page.waitForURL(/card\/held/);
  await page.locator('[data-current="true"]').waitFor();
  assert.equal(await link.evaluate(node => node === document.activeElement), true);
  assert.equal(await held.locator('h3').evaluate(node => node.scrollHeight <= node.clientHeight), true);
  assert.match(await held.textContent(), /Demo practice.*Due 2026-11-05/s);
  assert.match(await page.locator('[data-inbox-row="loop"]').textContent(), /Demo loop context/);
  await page.locator('[data-inbox-row="loop"] h3 a').click();
  assert.equal(await page.locator('[data-inbox-row="loop"] .inbox-source').count(), 0);
  await page.getByText('Done', { exact: true }).first().click();
  assert.equal(await page.locator('[data-inbox-row="done"]').isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `test-artifacts/home-inbox/context-${width}-${theme}.png`, fullPage: true });
  await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  await page.waitForFunction(() => document.querySelector('[data-inbox-row]') === null);
});

test('missing completion identity shows an error instead of actionable cards', async t => {
  const { page, calls } = await open(t, { malformed: true });
  await page.getByRole('alert').filter({ hasText: 'completion identity' }).waitFor();
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
  assert.equal(calls.some(call => call.name === 'settle-home-inbox'), false);
});

for (const intervening of ['snooze', 'source edit']) for (const uncertain of [false, true]) test(`newer ${intervening} is visible without stale Undo${uncertain ? ' after retry' : ''}`, async t => {
  const { page, calls } = await open(t, { intervening, uncertain, card: 'a', width: 390 });
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Hide from inbox', exact: true }).click();
  if (uncertain) {
    await page.getByRole('button', { name: 'Retry same request' }).click();
  }
  await page.getByText(/changed again.*latest state/i).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Undo/ }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Retry same request' }).count(), 0);
  const card = page.locator('[data-inbox-row="a"]');
  assert.equal(await card.isVisible(), true);
  if (intervening === 'snooze') {
    assert.match(await card.textContent(), /Snoozed until/);
    assert.equal(await card.locator('xpath=..').getAttribute('class'), 'inbox-shelf');
  } else {
    assert.match(await card.textContent(), /Edited elsewhere.*New deal.*Due 2026-11-06/s);
  }
  if (uncertain) {
    const writes = calls.filter(call => call.name === 'settle-home-inbox');
    assert.deepEqual(writes[0], writes[1]);
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`Mark done receipt and exact Undo ${width} ${theme}`, async t => {
  const { page, calls } = await open(t, { width, theme });
  const a = page.locator('[data-inbox-row="a"]');
  await a.getByRole('button', { name: 'Mark done', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByText('Marked done: Synthetic a.', { exact: false }).waitFor();
  await page.waitForFunction(() => document.activeElement.closest('[data-inbox-row]')?.dataset.inboxRow === 'b');
  assert.equal(await page.locator('[data-inbox-row="working"] .inbox-primary').count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `test-artifacts/home-inbox/complete-${width}-${theme}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Undone.', { exact: false }).waitFor();
  await a.getByRole('button', { name: 'Mark done', exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement.closest('[data-inbox-row]')?.dataset.inboxRow === 'a');
  const inverse = calls.find(call => call.name === 'reopen-one-action');
  assert.equal(inverse.args.base_version, 8);
  assert.equal(inverse.args.completion_event_id, '00000000-0000-0000-0000-000000000009');
  assert.equal(inverse.args.action_id, '00000000-0000-0000-0000-000000000002');
});
for (const taskLost of ['complete-one-action', 'reopen-one-action']) test(`lost ${taskLost} response retries the frozen request`, async t => {
  const { page, calls } = await open(t, { taskLost });
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Mark done', exact: true }).click();
  if (taskLost === 'reopen-one-action') await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await page.getByText(taskLost === 'complete-one-action' ? 'Marked done: Synthetic a.' : 'Undone.', { exact: false }).waitFor();
  const attempts = calls.filter(call => call.name === taskLost);
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
});
test('a newer task version refuses Undo without overwriting', async t => {
  const { page, calls } = await open(t, { taskConflict: true });
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText(/This task changed.*Nothing was overwritten/).waitFor();
  assert.equal(calls.filter(call => call.name === 'reopen-one-action').length, 1);
  assert.equal(await page.getByRole('button', { name: 'Retry same request' }).count(), 0);
});
test('a legacy completion receipt stays uncertain and retries without Undo', async t => {
  const { page, calls } = await open(t, { legacy: true });
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByText(/Result uncertain.*Completion event unreadable/).waitFor();
  assert.equal(await page.locator('[data-inbox-row="a"]').count(), 1);
  const reads = calls.filter(call => call.name === 'read-home-inbox-v3').length;
  await page.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await page.getByRole('button', { name: 'Retry same request', exact: true }).waitFor({ state: 'visible' });
  await page.getByText(/Result uncertain.*Completion event unreadable/).waitFor();
  const writes = calls.filter(call => call.name === 'complete-one-action');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(calls.filter(call => call.name === 'read-home-inbox-v3').length, reads);
  assert.doesNotMatch(await page.locator('.inbox-notice').textContent(), /Marked done|confirmed/);
  assert.doesNotMatch(await page.locator('.inbox-notice').textContent(), /You can undo/);
  assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
  assert.equal(calls.some(call => call.name === 'reopen-one-action'), false);
});

test('independent task receipts survive another Undo and refresh cannot invent one', async t => {
  const { page, calls } = await open(t);
  for (const id of ['a', 'b']) await page.locator(`[data-inbox-row="${id}"]`).getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByRole('button', { name: 'Undo Synthetic a', exact: true }).click();
  await page.getByText('Undone.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Undone.', { exact: false }).waitFor();
  assert.deepEqual(calls.filter(call => call.name === 'reopen-one-action').map(call => call.args.action_id), ['00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003']);
  await page.reload(); await page.locator('[data-inbox-row="a"]').waitFor();
  assert.equal(await page.getByRole('button', { name: /^Undo/ }).count(), 0);
});
test('snooze Cancel restores its opener and Working cannot be hidden or completed', async t => {
  const { page, calls } = await open(t, { card: 'working' });
  const working = page.locator('[data-inbox-row="working"]');
  assert.equal(await working.getByRole('button', { name: /Mark done|Hide from inbox/ }).count(), 0);
  assert.equal(await working.getByRole('checkbox').isDisabled(), true);
  const snooze = working.getByRole('button', { name: 'Snooze', exact: true });
  await snooze.click(); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await snooze.evaluate(node => node === document.activeElement), true);
  assert.equal(calls.some(call => call.name === 'complete-one-action' || call.name === 'settle-home-inbox'), false);
});

for (const action of ['Mark done', 'Hide from inbox']) test(`offline before ${action} Undo retains the frozen inverse through a lost response`, async t => {
  const { page, calls } = await open(t, { taskLost: 'reopen-one-action' });
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: action, exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Offline. No change was sent.', { exact: false }).waitFor();
  const inverseName = action === 'Mark done' ? 'reopen-one-action' : 'unsettle-home-inbox';
  assert.equal(calls.filter(call => call.name === inverseName).length, 0);
  await page.context().setOffline(false);
  const retry = page.getByRole('button', { name: 'Retry same request' });
  await retry.waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(node => node.textContent === 'Retry same request')?.disabled);
  assert.equal(calls.filter(call => call.name === inverseName).length, 0, 'reconnect does not replay without a gesture');
  await retry.click();
  if (action === 'Mark done') {
    await page.getByText('Result uncertain.', { exact: false }).waitFor();
    await retry.click();
    await page.getByText('Undone.', { exact: false }).waitFor();
    const attempts = calls.filter(call => call.name === inverseName);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(attempts[0].args.base_version, 8);
    assert.equal(attempts[0].args.completion_event_id, '00000000-0000-0000-0000-000000000009');
  }
  await page.getByText('Undone.', { exact: false }).waitFor();
  await page.waitForFunction(() => document.activeElement.closest('[data-inbox-row]')?.dataset.inboxRow === 'a');
  assert.equal(calls.filter(call => call.name === inverseName).length, action === 'Mark done' ? 2 : 1);
});
for (const target of ['extra10', 'extra9']) test(`scrolled completion of ${target} keeps receipt and Undo clear of mobile chrome`, async t => {
  const extra = Array.from({ length: 14 }, (_, i) => row(`extra${i}`, { action_id: `00000000-0000-0000-0000-${String(100 + i).padStart(12, '0')}` }));
  const { page } = await open(t, { width: 390, extra });
  await page.locator(`[data-inbox-row="${target}"]`).getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByText(`Marked done: Synthetic ${target}.`, { exact: false }).waitFor();
  await page.waitForFunction(id => document.activeElement.closest('[data-inbox-row]')?.dataset.inboxRow === id, target === 'extra10' ? 'extra11' : 'extra8');
  const notice = await page.locator('.inbox-notice').boundingBox();
  const undo = await page.getByRole('button', { name: 'Undo', exact: true }).boundingBox();
  await page.screenshot({ path: `/tmp/j62-${target}-receipt.png` });
  const safe = await page.evaluate(() => ({ top: Math.max(0, document.querySelector('.app-layout-tabbar')?.getBoundingClientRect().bottom || 0), bottom: Math.min(innerHeight, ...[...document.querySelectorAll('.app-shell-header, .app-layout-status')].map(node => node.getBoundingClientRect()).filter(box => box.height && box.top > innerHeight / 2).map(box => box.top)) }));
  assert.ok(notice.y >= safe.top && notice.y + notice.height <= safe.bottom, 'named receipt clears fixed mobile chrome');
  assert.ok(undo.y >= safe.top && undo.y + undo.height <= safe.bottom, 'Undo clears fixed mobile chrome');
  const focused = await page.locator('[data-inbox-row] h3 a:focus').boundingBox();
  assert.ok(focused.y >= notice.y + notice.height || focused.y + focused.height <= notice.y, 'receipt does not cover the focused neighbour');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
test('collapsed Working and Done shelves do not intercept previous-card focus', async t => {
  const { page } = await open(t);
  await page.locator('[data-inbox-row="b"]').getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByText('Marked done: Synthetic b.', { exact: false }).waitFor();
  await page.waitForFunction(() => document.activeElement.closest('[data-inbox-row]')?.dataset.inboxRow === 'a');
  assert.equal(await page.locator('details[open]').count(), 0);
});
test('collapsed nonempty shelves do not intercept empty-list Refresh focus', async t => {
  const { page } = await open(t);
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByText('Marked done: Synthetic a.', { exact: false }).waitFor();
  await page.locator('[data-inbox-row="b"]').getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByText('Marked done: Synthetic b.', { exact: false }).waitFor();
  await page.waitForFunction(() => document.activeElement.textContent === 'Refresh inbox');
  assert.equal(await page.locator('details[open]').count(), 0);
});


test('lease watch card opens the exact lease and snooze or settle never removes its watch', async t => {
 const lease='a593ce5f-a245-432b-a829-329a7a461a34';
 const notification=row('lease-alert',{source_type:'notification',kind_label:'Update',action_id:null,action_version:null,deal_id:null,open_url:`/leases?lease=${lease}`});
 const {page,calls}=await open(t,{card:'lease-alert',extra:[notification]});
 const card=page.locator('[data-inbox-row="lease-alert"]');
 assert.equal(await card.locator('.inbox-source').getAttribute('href'),`/leases?lease=${lease}`);
 await card.getByText('This alert is separate from its watch. Snoozing or settling the card keeps the watch.',{exact:true}).waitFor();
 await card.getByRole('button',{name:'Snooze',exact:true}).click();
 await page.getByRole('button',{name:/^1 hour/}).click();
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 await card.getByRole('button',{name:'Hide from inbox',exact:true}).click();
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 assert.equal(calls.some(call=>/^(unwatch|pause|resume|replace-subject-watch|watch-subject)/.test(call.name)),false);
 assert.equal(await card.locator('.inbox-source').getAttribute('href'),`/leases?lease=${lease}`);
 const fixture=(await readFile(new URL('../js/lease-radar-fixture.js',import.meta.url),'utf8')).replace('id:`demo-lease-${i}`',`id:i===1?'${lease}':\`demo-lease-\${i}\``);
 await page.route('**/js/lease-radar-fixture.js',route=>route.fulfill({body:fixture,contentType:'text/javascript'}));
 await card.locator('.inbox-source').click();
 await page.locator('#leaseDetail[open]').waitFor();
 assert.equal(new URL(page.url()).searchParams.get('lease'),lease);
 assert.equal(await page.locator('#leaseDetail h2').textContent(),'Demo Practice 1');
});


for(const destination of ['/leases','/leases?lease=demo','/leases?lease=a593ce5f-a245-432b-a829-329a7a461a34&lease=a593ce5f-a245-432b-a829-329a7a461a34','//foreign.example/leases?lease=a593ce5f-a245-432b-a829-329a7a461a34']) test(`lease card refuses ambiguous or foreign destination ${destination}`,async t=>{
 const {page}=await open(t,{card:'invalid-lease',extra:[row('invalid-lease',{source_type:'notification',kind_label:'Update',action_id:null,action_version:null,deal_id:null,open_url:destination})]});
 const card=page.locator('[data-inbox-row="invalid-lease"]');
 await card.getByText('Source record unavailable. Its destination is unsupported or invalid.',{exact:true}).waitFor();
 assert.equal(await card.locator('.inbox-source').count(),0);
 assert.equal(await card.locator('.watch-control').count(),0);
});
