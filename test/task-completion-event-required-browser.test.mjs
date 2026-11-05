import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
const bundles = await Promise.all(['home/home.tsx', 'home/inbox.tsx'].map(async name => {
  const result = await build({ entryPoints: [`src/ui/${name}`], bundle: true, write: false, format: 'esm', define: { 'process.env.NODE_ENV': '"production"' } });
  return result.outputFiles[0].text;
}));
for (const width of [390, 1440]) test(`public Home mount retains missing-event recovery and exact Undo at ${width}`, async t => {
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route('**/*', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill(path === '/home.js' || path === '/client.js' ? { contentType: 'text/javascript', body: bundles[path === '/home.js' ? 0 : 1] } : { contentType: 'text/html', body: '<!doctype html><main id="root"></main>' });
  });
  await page.goto('http://localhost/inbox');
  await page.evaluate(async () => {
    const { mountInbox } = await import('/home.js');
    const { createInboxClient } = await import('/client.js');
    const action = '00000000-0000-4000-8000-000000000002';
    const event = '00000000-0000-4000-8000-000000000009';
    const item = { completed_at: null, auto_settled: false, item_id: 'synthetic', source_type: 'next_action', source_id: action, source_version: 's1', source_state: 'needs_attention', title: 'Synthetic task', activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', context_label: null, due_on: null, open_url: null, kind_label: 'Task', merged_source_ids: [], action_id: action, action_version: 1, deal_id: null };
    window.writes = [];
    const client = createInboxClient(async (name, args) => {
      if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return { error: 'unknown_tool' };
      if (name === 'read-home-inbox-v3') return { ok: true, schema_version: 'home-inbox.v3', truncated: false, limit: 1000, items: [item], working_collapsed: true, auto_settle_enabled: true };
      window.writes.push({ name, args: structuredClone(args) });
      const done = name === 'complete-one-action';
      Object.assign(item, { action_version: done ? 2 : 3, source_state: done ? 'done' : 'needs_attention' });
      return { ok: true, action_id: action, version: item.action_version, status: done ? 'done' : 'open', ...(window.writes.length > 1 ? { completion_event_id: event } : {}) };
    });
    mountInbox(document.querySelector('#root'), client);
  });
  await page.getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByRole('button', { name: 'Retry same request', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Undone.', { exact: false }).waitFor();
  const writes = await page.evaluate(() => window.writes);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[2].args.completion_event_id, '00000000-0000-4000-8000-000000000009');
  await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await page.locator('[data-inbox-row]').count(), 0);
});
