import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import axe from 'axe-core';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
let outDir;
before(async () => { outDir = temporaryDirectory('inbox-v3-'); await buildArtifact({ root: process.cwd(), outDir }); await mkdir('test-artifacts/inbox-v3', { recursive: true }); });
after(async () => { await rm(outDir, { recursive: true, force: true }); });
for (const width of [390, 1024, 1280, 1440]) for (const theme of ['light', 'dark']) test(`automatic settlement reasons and lifecycle on Home ${width} ${theme}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'America/Chicago' });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  const id = '00000000-0000-0000-0000-000000000001';
  const rows = ['next_action', 'email_proposal', 'fact_review', 'tour_feedback'].map((source_type, i) => ({ item_id: String(i), source_type, source_id: String(i), source_version: 's1', source_state: 'done', title: `Resolved ${source_type}`, activity_at: '2026-11-03T12:00:00Z', hold_until: null, unseen: false, disposition: 'settled', snoozed_until: null, explicit_unsettle: false, section: 'settled', base_version: 'opaque:1', context_label: null, due_on: null, open_url: null, kind_label: ['Task', 'Reply draft', 'Fact review', 'Tour feedback'][i], merged_source_ids: [], action_id: i === 0 ? id : null, action_version: i === 0 ? 7 : null, deal_id: null, auto_settled: true }));
  const calls = [];
  await page.route('**/mcp', route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } });
    calls.push({ name, args });
    let payload = name === 'read-home-inbox-v3' ? { ok: true, schema_version: 'home-inbox.v3', auto_settle_enabled: true, working_collapsed: true, truncated: false, limit: 1000, items: rows }
      : name === 'calendar-meeting-prep' ? { state: 'empty', items: [] } : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    if (name.endsWith('-home-inbox')) {
      const item = rows.find(item => item.item_id === args.items[0].item_id);
      Object.assign(item, { auto_settled: false, disposition: name.startsWith('unsettle') ? 'inbox' : name.startsWith('snooze') ? 'snoozed' : 'settled', explicit_unsettle: name.startsWith('unsettle'), snoozed_until: args.until || null, base_version: item.base_version + 'x' }); item.section = item.disposition;
      payload = { ok: true, schema_version: 'home-inbox-command.v1', results: [{ item_id: item.item_id, ok: true, item }] };
    }
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  const done = page.getByRole('region', { name: 'Earlier and undated completions', exact: true });
  await done.getByRole('button', { name: 'See all 4', exact: true }).click();
  assert.equal(await done.getByText('Done, time not recorded', { exact: true }).count(), 4);
  assert.equal(await page.getByRole('region', { name: 'Hidden from inbox', exact: true }).locator('[data-inbox-row]').count(), 0);
  assert.equal(await page.getByRole('region', { name: 'In motion and waiting', exact: true }).locator('[data-inbox-row]').count(), 0);
  assert.doesNotMatch(await done.textContent(), /by you/);
  await page.addScriptTag({ content: axe.source });
  assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations), []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `test-artifacts/inbox-v3/home-${width}-${theme}.png`, fullPage: true });
  const card = page.locator('[data-inbox-row="0"]');
  await card.getByRole('button', { name: 'Show in inbox', exact: true }).click();
  await page.getByRole('region', { name: 'Needs your attention', exact: true }).locator('[data-inbox-row="0"]').waitFor();
  await card.getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.getByRole('button', { name: /^1 hour/ }).click();
  await page.getByRole('region', { name: 'In motion and waiting', exact: true }).getByRole('button', { name: 'See all 1', exact: true }).click();
  await page.getByRole('region', { name: 'In motion and waiting', exact: true }).locator('[data-inbox-row="0"]').waitFor();
  await card.getByRole('button', { name: 'Wake', exact: true }).click();
  await card.getByRole('button', { name: 'Hide from inbox', exact: true }).click();
  await page.getByRole('region', { name: 'Hidden from inbox', exact: true }).getByText('Hidden from inbox by you', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('region', { name: 'Needs your attention', exact: true }).locator('[data-inbox-row="0"]').waitFor();
  assert.ok(calls.some(call => call.name === 'read-home-inbox-v3'));
});

for (const refusal of ['unknown_tool', 'partner_required', 'malformed']) test(`Home reports v3 ${refusal} truthfully`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  const calls = [];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } }); calls.push(name);
    const payload = name === 'read-home-inbox-v3' ? { error: refusal }
      : name === 'read-home-inbox-v2' ? { ok: true, schema_version: 'home-inbox.v2', auto_settle_enabled: false, working_collapsed: true, truncated: false, limit: 1000, items: [] }
      : name === 'calendar-meeting-prep' ? { state: 'empty', items: [] } : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  if (refusal === 'unknown_tool') {
    await page.getByText('Automatic settlement unavailable. Showing the earlier inbox; completed items may still need review.', { exact: true }).waitFor();
    assert.ok(calls.includes('read-home-inbox-v2'));
  } else {
    await page.getByRole('heading', { name: 'Inbox unavailable', exact: true }).waitFor();
    assert.equal(calls.includes('read-home-inbox-v2'), false);
  }
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
});

for (const [transition, before, after] of [
  ['Canonical work resolves', { source_state: 'needs_attention', section: 'inbox' }, { source_state: 'done', section: 'settled', disposition: 'settled', auto_settled: true }],
  ['Work needs review', { source_state: 'working', section: 'working' }, { source_state: 'needs_attention', section: 'inbox' }],
  ['Processing completes', { source_state: 'working', section: 'working' }, { source_state: 'done', section: 'done' }],
  ['Snooze expires after resolution', { source_state: 'done', section: 'snoozed', disposition: 'snoozed', snoozed_until: '2099-01-01T00:00:00Z' }, { source_state: 'done', section: 'settled', disposition: 'settled', auto_settled: true }],
  ['Canonical work reopens', { source_state: 'done', section: 'inbox', explicit_unsettle: true }, { source_state: 'needs_attention', section: 'inbox', explicit_unsettle: true }],
]) test(`Home refresh transition ${transition}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  const id = '00000000-0000-0000-0000-000000000001';
  const item = { item_id: 'transition', source_id: id, source_type: transition === 'Processing completes' ? 'capture_session' : 'next_action', source_version: 's1', title: 'Synthetic transition', activity_at: '2026-11-03T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, base_version: 'opaque:1', context_label: null, due_on: null, open_url: null, kind_label: transition === 'Processing completes' ? 'Call' : 'Task', merged_source_ids: [], action_id: transition === 'Processing completes' ? null : id, action_version: transition === 'Processing completes' ? null : 7, deal_id: null, auto_settled: false, ...before };
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/mcp', route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } });
    let payload = name === 'read-home-inbox-v3' ? { ok: true, schema_version: 'home-inbox.v3', auto_settle_enabled: true, working_collapsed: true, truncated: false, limit: 1000, items: [item] } : { items: [] };
    if (name === 'settle-home-inbox') {
      Object.assign(item, { section: 'settled', disposition: 'settled', base_version: 'opaque:2' });
      payload = { ok: true, schema_version: 'home-inbox-command.v1', results: [{ item_id: args.items[0].item_id, ok: true, item }] };
    }
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  if (['working', 'snoozed'].includes(before.section)) await page.getByRole('region', { name: 'In motion and waiting', exact: true }).getByRole('button', { name: 'See all 1', exact: true }).click();
  await page.locator('[data-inbox-row="transition"]').waitFor();
  Object.assign(item, after);
  await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  const section = after.section === 'settled' || after.section === 'done' ? 'Earlier and undated completions' : 'Needs your attention';
  await page.getByRole('region', { name: section, exact: true }).locator('[data-inbox-row="transition"]').waitFor();
  if (after.auto_settled) await page.getByText('Done, time not recorded', { exact: true }).waitFor();
  else await page.locator('[data-inbox-row="transition"] .inbox-badge').filter({ hasText: after.source_state.replaceAll('_', ' ') }).waitFor();
  if (transition === 'Processing completes') {
    await page.locator('[data-inbox-row="transition"]').getByRole('button', { name: 'Hide from inbox', exact: true }).click();
    await page.getByRole('region', { name: 'Hidden from inbox', exact: true }).getByText('Hidden from inbox by you', { exact: true }).waitFor();
  }
});
