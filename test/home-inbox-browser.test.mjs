import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, fixtureServer } from './browser-harness.mjs';

const row = (item_id, fields = {}) => ({ item_id, source_type: 'task', source_id: item_id, source_version: 'v1', source_state: 'needs_attention', title: `Synthetic ${item_id}`, activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', ...fields });
async function open(t, { refusal = false, width = 1440, theme = 'light', card = '', partial = false, uncertain = false } = {}) {
  const server = await fixtureServer({ root: join(process.cwd(), 'dist/site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  const items = [row('a'), row('b', { source_state: 'done', unseen: true }), row('working', { source_state: 'working', section: 'working' })];
  const calls = []; let writes = 0;
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-inbox' } }));
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params; calls.push({ name, args });
    let payload;
    if (name === 'read-home-inbox') payload = refusal ? { ok: false, error: 'read_limit_exceeded' } : { ok: true, schema_version: 'home-inbox.v1', items, working_collapsed: true, auto_settle_enabled: false };
    else if (!name.endsWith('-home-inbox')) payload = { ok: true, items: [], counts: {}, suggestions: [], enabled: false };
    else {
      writes++;
      if (uncertain && writes === 1) return route.abort();
      payload = { ok: true, schema_version: 'home-inbox-command.v1', results: args.items.map(({ item_id }) => {
        if (partial && item_id === 'b') return { item_id, ok: false, error: 'version_conflict', current_version: 'v9' };
        const item = items.find(item => item.item_id === item_id);
        Object.assign(item, { disposition: name.startsWith('unsettle') ? 'inbox' : name.startsWith('snooze') ? 'snoozed' : 'settled', snoozed_until: args.until || null, base_version: `opaque:${writes + 1}` });
        return { item_id, ok: true, item };
      }) };
    }
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/home${card ? `/card/${card}` : ''}?mode=live`);
  return { page, calls };
}
test('React Home renders one inbox, collapsed Working and Done badge; current card stays reachable', async t => {
  const { page, calls } = await open(t, { card: 'working' });
  await page.getByRole('heading', { name: 'Synthetic working', exact: true }).waitFor();
  assert.equal(await page.locator('details[open]').count(), 0);
  assert.equal(await page.locator('[data-inbox-row]').count(), 3);
  assert.equal(await page.getByText('Done · Unseen', { exact: true }).count(), 1);
  assert.equal(calls.filter(call => call.name === 'read-home-inbox').length, 1);
  assert.deepEqual(calls.filter(call => ['deal-room-board', 'morning-brief', 'read-home-agenda', 'get-deal-room'].includes(call.name)), [], 'Home waits to read secondary shell data until its surface is opened');
});
test('settle and snooze have reversible Undo, and focus returns to a reachable row', async t => {
  const { page } = await open(t);
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Settle', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.getByRole('button', { name: '1 hour', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Settle', exact: true }).waitFor();
  assert.equal(await page.locator('details[open]').count(), 0);
  await page.waitForFunction(() => document.activeElement.closest('[data-inbox-row]') !== null);
});
test('partial bulk failure keeps failed card and retry preserves key and arguments', async t => {
  const { page, calls } = await open(t, { partial: true });
  await page.getByLabel('Select Synthetic a', { exact: true }).check();
  await page.getByLabel('Select Synthetic b', { exact: true }).check();
  await page.getByRole('button', { name: 'Settle selected', exact: true }).click();
  await page.getByText('version_conflict', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await page.getByText('version_conflict', { exact: false }).waitFor();
  await page.waitForTimeout(60);
  const writes = calls.filter(call => call.name === 'settle-home-inbox');
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(await page.locator('[data-inbox-row="b"]').isVisible(), true);
});
test('uncertain outcome never moves card; manual retry reuses exact request; offline sends nothing', async t => {
  const { page, calls } = await open(t, { uncertain: true });
  const settle = page.locator('[data-inbox-row="a"]').getByRole('button', { name: 'Settle', exact: true });
  await settle.click(); await page.getByRole('button', { name: 'Retry same request' }).waitFor();
  assert.equal(await settle.isVisible(), true);
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  assert.deepEqual(calls.filter(call => call.name === 'settle-home-inbox')[0], calls.filter(call => call.name === 'settle-home-inbox')[1]);
  await page.context().setOffline(true);
  await page.locator('[data-inbox-row="b"]').getByRole('button', { name: 'Settle', exact: true }).click();
  await page.getByText('Offline.', { exact: false }).first().waitFor();
  assert.equal(calls.filter(call => call.name === 'settle-home-inbox').length, 2);
});
test('read refusal shows error instead of empty', async t => {
  const { page } = await open(t, { refusal: true });
  await page.getByRole('alert').filter({ hasText: 'Inbox unavailable' }).waitFor();
  assert.equal(await page.getByText('You’re all caught up.', { exact: true }).count(), 0);
});
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`inbox evidence ${width} ${theme}`, async t => {
  const { page } = await open(t, { width, theme });
  await page.locator('[data-inbox-row="a"]').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mkdir('test-artifacts/home-inbox', { recursive: true });
  await page.screenshot({ path: `test-artifacts/home-inbox/${width}-${theme}.png`, fullPage: true });
});
