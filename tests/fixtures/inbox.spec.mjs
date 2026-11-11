import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { ownedServer as startFixtureServer } from '../../test/fixture-probe.ts';
import { temporaryDirectory } from '../../scripts/temp-directory.mjs';
import { buildArtifact } from '../../scripts/artifact.mjs';

let server, outDir;
test.beforeAll(async () => { outDir = await temporaryDirectory('doctorcre-inbox-'); await buildArtifact({ root: process.cwd(), outDir }); server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(outDir, 'site') } }); });
test.afterAll(async () => { await server?.stop(); if (outDir) await rm(outDir, { recursive: true, force: true }); });

test('Sectioned Home opens a card in the full inbox', async ({ page }) => {
  await page.goto(`${server.url}/`);
  await expect(page.getByRole('heading', { name: 'Welcome home.' })).toBeVisible();
  await page.locator('[data-inbox-row] h3 a').first().click();
  await expect(page).toHaveURL(/\/inbox\/card\//);
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  await expect(page.locator('#dealAttention')).toHaveCount(0);
  await expect(page.locator('#homeMeetingReviews, #homeCallTasks, #homeEmailFilings')).toHaveCount(0);
});

test('Open source record links each inbox source type to a page that opens it, or not at all', async ({ page }) => {
  const card = (item_id, source_type, source_id) => ({ auto_settled: false, item_id, source_type, source_id, source_version: 'v1', source_state: 'needs_attention', title: `Synthetic ${source_type}`, activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', context_label: 'Demo practice with a long owning deal name', due_on: '2026-11-05', open_url: '/deals?deal=00000000-0000-0000-0000-000000000001&focus=next-step', kind_label: 'Task', merged_source_ids: ['00000000-0000-0000-0000-000000000002'], action_id: '00000000-0000-0000-0000-000000000002', action_version: 7, deal_id: '00000000-0000-0000-0000-000000000001',  });
  const items = [card('next_action:t1', 'next_action', 't1'), card('capture_session:s1', 'capture_session', 's1'), card('capture_post_call_action:a1', 'capture_post_call_action', 'a1'), card('email_proposal:p1', 'email_proposal', 'p1'), card('notification:n1', 'notification', '["deal","d1"]')];
  for (const item of items) {
    item.open_url = ['capture_session', 'capture_post_call_action'].includes(item.source_type) ? '/calls' : item.source_type === 'notification' ? '/updates' : null;
    if (!['next_action', 'capture_post_call_action'].includes(item.source_type)) Object.assign(item, { action_id: null, action_version: null });
    if (['capture_session', 'email_proposal'].includes(item.source_type)) item.deal_id = null;
  }
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-inbox' } }));
  await page.route('**/mcp', async route => {
    const { name } = route.request().postDataJSON().params;
    if (['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name)) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }] } } });
    const payload = name === 'read-home-inbox-v3' ? { ok: true, schema_version: 'home-inbox.v3', truncated: false, limit: 1000, working_collapsed: true, auto_settle_enabled: true, items } : { ok: true };
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  for (const [itemId, href] of [['next_action:t1', null], ['capture_session:s1', '/calls'], ['capture_post_call_action:a1', '/calls'], ['notification:n1', '/updates'], ['email_proposal:p1', null]]) {
    await page.goto(`${server.url}/inbox/card/${encodeURIComponent(itemId)}?mode=live`);
    await expect(page.locator('[data-current="true"]')).toHaveCount(1);
    const link = page.getByRole('link', { name: 'Open source record ↗' });
    if (href) await expect(link).toHaveAttribute('href', href);
    else await expect(link).toHaveCount(0);
  }
});

test('Home meeting confirmation offers only open, active deals', async ({ page }) => {
  const seed = JSON.parse(await readFile(new URL('../../data/board-seed.json', import.meta.url), 'utf8'));
  const base = seed.deals.find(deal => deal.id === 'd14');
  seed.deals.push({ ...base, id: 'demo-closed', name: 'Demo closed purchase', phase: 'Closed', outcome: 'won', closed_on: '2026-09-01' },
    { ...base, id: 'demo-paused', name: 'Demo paused lease', operating_state: 'paused' });
  await page.route('**/data/board-seed.json', route => route.fulfill({ json: seed }));
  // The brief loads independently of the agenda. Inject the review only after
  // its initial calendar publication, so that read cannot overwrite our case.
  await page.goto(`${server.url}/review-workflows`);
  await expect(page.locator('#observedAt')).not.toHaveText('Updating…');
  await expect(page.locator('#morningUpdated')).toHaveAttribute('datetime', /.+/);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('doctorcre:brief-calendar', { detail: {
    state: 'partial', items: [], notes: [], follow_up_reviews: [{ key: 'cccccccccccccccc', state: 'needs_review', title: 'Demo picker meeting', start: '2026-10-01T13:00:00Z', end: '2026-10-01T14:00:00Z' }],
  } })));
  const picker = page.locator('#homeMeetingReviews select');
  await expect(picker.locator('option', { hasText: base.name })).toHaveCount(1);
  await expect(picker.locator('option', { hasText: 'Demo closed purchase' })).toHaveCount(0);
  await expect(picker.locator('option', { hasText: 'Demo paused lease' })).toHaveCount(0);
});
