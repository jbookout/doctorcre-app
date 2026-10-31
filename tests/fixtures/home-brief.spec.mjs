import { test, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { temporaryDirectory } from '../../scripts/temp-directory.mjs';
import { buildArtifact } from '../../scripts/artifact.mjs';
let server, outDir;
test.beforeAll(async () => { outDir = await temporaryDirectory('doctorcre-inbox-playwright-'); await buildArtifact({ root: process.cwd(), outDir }); server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(outDir, 'site') } }); });
test.afterAll(async () => { await server?.stop(); if (outDir) await rm(outDir, { recursive: true, force: true }); });
for (const state of ['populated', 'empty', 'loading', 'unavailable']) for (const width of [1440, 390]) for (const theme of ['light', 'dark']) test(`Home inbox ${state} at ${width} in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-inbox' } }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/mcp', async route => {
    const { name } = route.request().postDataJSON().params;
    let payload = { ok: true, items: [], counts: {}, suggestions: [], enabled: false };
    if (name === 'read-home-inbox') {
      if (state === 'loading') await gate;
      payload = state === 'unavailable' ? { ok: false, error: 'read_limit_exceeded' } : { ok: true, schema_version: 'home-inbox.v1', working_collapsed: true, auto_settle_enabled: false, items: state === 'empty' ? [] : [{ item_id: 'synthetic-card', source_type: 'task', source_id: 'synthetic-task', source_version: 'v1', source_state: 'done', title: 'Synthetic tour summary ready', activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: true, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1' }] };
    }
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  try {
    await page.goto(server.url + '/home?mode=live');
    if (state === 'loading') await expect(page.getByText('Loading your inbox…', { exact: true })).toBeVisible();
    else if (state === 'unavailable') await expect(page.getByRole('alert')).toContainText('Inbox unavailable');
    else if (state === 'empty') await expect(page.getByText('You’re all caught up.', { exact: true })).toBeVisible();
    else { await expect(page.locator('[data-inbox-row]')).toHaveCount(1); await expect(page.getByText('Done · Unseen', { exact: true })).toBeVisible(); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { release(); }
});
