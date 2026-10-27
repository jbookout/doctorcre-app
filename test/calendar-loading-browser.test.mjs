import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Calendar opens confirmed dates while another deal is pending and clears them on session expiry', async t => {
  const outDir = await temporaryDirectory('calendar-loading-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  const { server } = await createQaServer({ buildRoot: join(outDir, 'site') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const status of [200, 401]) await t.test(String(status), async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'doctorcre-app-staging.joe-bookout-carr-us.workers.dev') return route.abort();
      const response = await page.request.fetch(`${origin}${url.pathname}${url.search}`, {
        method: route.request().method(), data: route.request().postData() ?? undefined,
        headers: { 'content-type': 'application/json' },
      });
      return route.fulfill({ response });
    });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let releaseLate;
    const late = new Promise(resolve => { releaseLate = resolve; });
    const answer = (route, data) => route.fulfill({ json: { jsonrpc: '2.0', id: 1, result: {
      content: [{ type: 'text', text: JSON.stringify(data) }],
    } } });
    await page.route('**/mcp', async route => {
      const { name, arguments: args } = route.request().postDataJSON().params;
      if (name === 'deal-room-board') return answer(route, { actor: 'joe', deals: [
        { id: 'fast', name: 'Synthetic confirmed deal', owner: 'joe' },
        { id: 'slow', name: 'Synthetic pending deal', owner: 'joe' },
        ...(status === 401 ? [{ id: 'late', name: 'Synthetic late deal', owner: 'joe' }] : []),
      ] });
      if (name !== 'get-deal-room') return route.fallback();
      if (args.deal === 'late') await late;
      if (args.deal === 'slow') {
        await held;
        if (status === 401) return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
      }
      return answer(route, { deal_id: args.deal, critical_dates: [{
        id: args.deal, kind: 'loi_expiry', due_on: '2026-10-20', status: 'open', note: `Synthetic ${args.deal} date`,
      }] });
    });
    try {
      await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `calendar-${status}`, reset: true } });
      await page.goto('https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev/calendar');
      const agenda = page.locator('.cal-agenda-item');
      await expect(agenda).toHaveCount(1, { timeout: 1000 });
      await expect(page.locator('#calAgenda')).toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('#calStatusLabel')).toHaveText(`Reading 1 of ${status === 401 ? 3 : 2} deals…`);
      await agenda.click();
      await expect(page.locator('#dayPanelBody')).toContainText('Synthetic fast date');
      await mkdir(join(root, 'test-artifacts/calendar-loading'), { recursive: true });
      await page.screenshot({ path: join(root, `test-artifacts/calendar-loading/pending-${status}.png`), fullPage: true });
      release();
      if (status === 200) {
        await expect(agenda).toHaveCount(2);
        await expect(page.locator('#calAgenda')).toHaveAttribute('aria-busy', 'false');
        await expect(page.locator('#calStatusLabel')).toHaveText('Current');
        await expect(page.locator('.cal-day-open[data-select-day="2026-10-20"]')).toBeFocused();
      } else {
        await page.waitForURL('**/public-shell/session-ended.html');
        await expect(page.getByRole('heading',{name:'Session ended'})).toBeVisible();
        await expect(agenda).toHaveCount(0);
        releaseLate();
        await expect(page.locator('body')).not.toContainText('Synthetic fast date');

      }
    } finally {
      release();
      releaseLate();
      await page.close();
    }
  });
});
