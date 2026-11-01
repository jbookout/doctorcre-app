import { test, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { temporaryDirectory } from '../../scripts/temp-directory.mjs';
import { buildArtifact } from '../../scripts/artifact.mjs';

// The partner workflows that lived on the old Home stay reachable on the new
// inbox Home: undo an email filing, confirm a meeting happened, and
// work the post-call follow-up backlog. Every payload is synthetic.
let server, outDir;
test.beforeAll(async () => { outDir = await temporaryDirectory('doctorcre-home-workflows-'); await buildArtifact({ root: process.cwd(), outDir }); server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(outDir, 'site') } }); });
test.afterAll(async () => { await server?.stop(); if (outDir) await rm(outDir, { recursive: true, force: true }); });

const hour = 3_600_000;
const iso = offset => new Date(Date.now() + offset).toISOString();
const payloads = () => ({
  'read-home-inbox': { ok: true, schema_version: 'home-inbox.v1', working_collapsed: true, auto_settle_enabled: false, items: [] },
  'list-email-thread-filings': { filings: [{ event_id: 'synthetic-filing-1', deal: 'demo-deal', activity_id: 'synthetic-activity-1', recorded_at: iso(-hour), summary: 'Synthetic summary', subject: 'Synthetic lease question', sender_name: 'Demo Sender', occurred_at: iso(-2 * hour), activity_version: 1 }] },
  'undo-email-thread-filing': { ok: true, activity_id: 'synthetic-activity-1' },
  'morning-brief': { sections: { calendar: { state: 'ok', items: [], follow_up_reviews: [{ key: '0123456789abcdef', state: 'needs_review', title: 'Synthetic site tour', start: iso(-3 * hour), end: iso(-2 * hour) }] } } },
  'deal-room-board': { actor: 'joe', deals: [{ id: 'demo-deal', name: 'Demo Clinic Lease', owner: 'joe', phase: 'research', type: 'startup' }] },
  'log-activity': { ok: true, activity_id: 'synthetic-meeting-1' },
  'read-post-call-followups': { schema_version: 'post-call-followups.v1', send: false, candidates: [{ id: 'synthetic-candidate-1', kind: 'assigned_action', session_id: 'synthetic-session', deal_id: 'demo-deal', deal_name: 'Demo Clinic Lease', payload: { deal_id: 'demo-deal', assignee: 'joe', action: 'Send the synthetic floor plan', due_on: null }, created_at: iso(-hour), evidence_quote: null }] },
  'resolve-post-call-candidate': { ok: true, candidate_id: 'synthetic-candidate-1', status: 'confirmed', ref: 'synthetic-task-1', assignee: 'joe' },
});

async function openHome(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme: 'light', walkthroughSeen: { joe: true } })));
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-workflows' } }));
  const calls = [], data = payloads();
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    calls.push({ name, args });
    const payload = data[name] ?? { ok: true, items: [], counts: {}, suggestions: [], enabled: false };
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(server.url + '/home?mode=live');
  return calls;
}

for (const width of [1440, 390]) {
  test(`Home keeps Undo filing for filed emails at ${width}`, async ({ page }) => {
    const calls = await openHome(page, width);
    const panel = page.getByRole('region', { name: 'Filed automatically' });
    await expect(panel.getByText('Synthetic lease question')).toBeVisible();
    await panel.getByRole('button', { name: 'Undo filing Synthetic lease question' }).click();
    await expect(panel.getByText(/Undone\. The email is no longer filed/)).toBeVisible();
    const undo = calls.find(call => call.name === 'undo-email-thread-filing');
    expect(undo?.args.event_id).toBe('synthetic-filing-1');
    expect(typeof undo?.args.idempotency_key).toBe('string');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`Home keeps meeting confirmation at ${width}`, async ({ page }) => {
    const calls = await openHome(page, width);
    const panel = page.getByRole('region', { name: 'Did these meetings happen?' });
    await expect(panel.getByText('Synthetic site tour')).toBeVisible();
    await panel.getByLabel('Deal for Synthetic site tour').selectOption('demo-deal');
    await panel.getByRole('button', { name: 'It happened' }).click();
    await expect(panel.getByText('Meeting logged on Demo Clinic Lease.')).toBeVisible();
    const log = calls.find(call => call.name === 'log-activity');
    expect(log?.args).toMatchObject({ ref: 'demo-deal', kind: 'meeting', summary: 'Meeting: Synthetic site tour' });
    expect(typeof log?.args.idempotency_key).toBe('string');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`Home keeps the post-call follow-up backlog at ${width}`, async ({ page }) => {
    const calls = await openHome(page, width);
    const panel = page.getByRole('region', { name: 'Call follow-ups to review' });
    await expect(panel.getByText('Send the synthetic floor plan')).toBeVisible();
    await panel.getByRole('button', { name: 'Add Joe task' }).click();
    await expect(panel.getByText('Task added')).toBeVisible();
    const resolve = calls.find(call => call.name === 'resolve-post-call-candidate');
    expect(resolve?.args).toMatchObject({ candidate_id: 'synthetic-candidate-1', accept: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('Open source record links each server source type to its own page, or not at all', async ({ page }) => {
  const card = (item_id, source_type, source_id) => ({ item_id, source_type, source_id, source_version: 'v1', source_state: 'needs_attention', title: `Synthetic ${source_type}`, activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1' });
  const items = [card('next_action:t1', 'next_action', 't1'), card('capture_session:s1', 'capture_session', 's1'), card('email_proposal:p1', 'email_proposal', 'p1'), card('notification:n1', 'notification', '["deal","d1"]')];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-workflows' } }));
  await page.route('**/mcp', async route => {
    const { name } = route.request().postDataJSON().params;
    const payload = name === 'read-home-inbox' ? { ok: true, schema_version: 'home-inbox.v1', working_collapsed: true, auto_settle_enabled: false, items } : { ok: true };
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  for (const [itemId, href] of [['next_action:t1', '/tasks/t1'], ['capture_session:s1', '/calls'], ['notification:n1', '/updates'], ['email_proposal:p1', null]]) {
    await page.goto(`${server.url}/home/card/${encodeURIComponent(itemId)}?mode=live`);
    await expect(page.getByRole('heading', { name: 'Current card' })).toBeVisible();
    const link = page.getByRole('link', { name: 'Open source record ↗' });
    if (href) await expect(link).toHaveAttribute('href', href);
    else await expect(link).toHaveCount(0);
  }
});
