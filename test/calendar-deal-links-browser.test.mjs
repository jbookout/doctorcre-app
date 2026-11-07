import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect as baseExpect } from '@playwright/test';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium, WAIT_MS } from './browser-harness.mjs';

const expect = baseExpect.configure({ timeout: WAIT_MS });
const root = fileURLToPath(new URL('../', import.meta.url));
const calendarPath = '/calendar?view=month&d=2026-10-01&day=2026-10-20';
const sameName = 'Demo Joe Dental Relocation 001';
const longName = `Demo ${'Extraordinarily Long Multi-Specialty Medical Office Building Relocation '.repeat(3)}`;
const undatedId = 'qa/deal?3&x="yes"';

test('Calendar opens each owning deal and Back restores the selected period and day', async t => {
  const outDir = await temporaryDirectory('calendar-deal-links-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, 'site') })).start();
  t.after(() => server.close());
  const origin = server.origin;
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await t.test(`${width} ${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const calls = [];
      const errors = [];
      const roomReads = [];
      let empty = false;
      let missingDestination = false;
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(theme => {
        localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme }));
      }, theme);
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'doctorcre-app-staging.joe-bookout-carr-us.workers.dev') return route.abort();
        const request = url.pathname === '/mcp' ? route.request().postDataJSON() : null;
        const originalDeal = request?.params.arguments?.deal;
        if (originalDeal === undatedId || originalDeal === '') request.params.arguments.deal = 'qa-deal-3';
        const response = await page.request.fetch(`${origin}${url.pathname}${url.search}`, {
          method: route.request().method(), data: request ?? route.request().postData() ?? undefined,
          headers: { 'content-type': 'application/json' },
        });
        if (url.pathname !== '/mcp') return route.fulfill({ response });
        const { name, arguments: args } = route.request().postDataJSON().params;
        calls.push(name);
        if (name === 'get-deal-room') roomReads.push(originalDeal);
        const payload = await response.json();
        if (name === 'deal-room-board' || name === 'get-deal-room') {
          const data = JSON.parse(payload.result.content[0].text);
          if (name === 'deal-room-board') {
            data.deals = empty ? [] : missingDestination ? [{ ...data.deals[2], id: '' }] : data.deals.slice(0, 4);
            data.deals.forEach(deal => {
              if (deal.id === 'qa-deal-1' || deal.id === 'qa-deal-2') deal.name = sameName;
              if (deal.id === 'qa-deal-3') { deal.id = undatedId; deal.name = `${sameName}0`; }
              if (deal.id === 'qa-deal-4') deal.name = longName;
            });
          } else {
            data.id = originalDeal;
            if (originalDeal === 'qa-deal-1' || originalDeal === 'qa-deal-2') data.name = sameName;
            if (originalDeal === undatedId) data.name = `${sameName}0`;
            if (originalDeal === 'qa-deal-4') data.name = longName;
            data.deal_id = originalDeal;
            data.critical_dates = [{
              id: `date-${args.deal}`, kind: 'loi_expiry', status: 'open',
              due_on: args.deal === undatedId || args.deal === '' ? null : '2026-10-20',
              note: `Synthetic requirement for ${args.deal} ${'with long recorded context '.repeat(8)}`,
            }];
          }
          payload.result.content[0].text = JSON.stringify(data);
        }
        return route.fulfill({ json: payload });
      });
      try {
        await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `deal-links-${width}-${theme}`, reset: true } });
        await page.goto(`https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev${calendarPath}`);
        await expect(page.locator('#calStatusLabel')).toHaveText('Current');
        await expect(page.locator('#dayPanelBody .cal-day-entry')).toHaveCount(3);
        const links = page.locator('#dayPanelBody a, #calUndatedList a');
        await expect(links).toHaveCount(4);
        assert.deepEqual(await links.evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))), [
          '/deals?deal=qa-deal-1', '/deals?deal=qa-deal-2', '/deals?deal=qa-deal-4', '/deals?deal=qa%2Fdeal%3F3%26x%3D%22yes%22',
        ]);
        for (const row of await page.locator('#dayPanelBody .cal-day-entry, #calUndatedList li').all()) {
          const name = await row.locator('a').textContent();
          assert.equal((await row.textContent()).split(name).length - 1, 1, 'deal name appears once per row');
        }
        for (const link of await links.all()) await expect(link).toHaveAccessibleName(/^Demo/);
        assert.equal(calls.filter(name => name === 'get-deal-room').length, 4);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const evidence = join(root, '.github/pr-evidence/WR636.S1.J11');
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `calendar-${width}-${theme}.png`), fullPage: true });
        const period = await page.locator('#calPeriod').textContent();
        const calendarUrl = page.url();
        for (const id of ['qa-deal-1', 'qa-deal-2', 'qa-deal-4', undatedId]) {
          const href = `/deals?deal=${encodeURIComponent(id)}`;
          const link = page.locator(`a[href="${href}"]`);
          const label = await link.textContent();
          const before = roomReads.length;
          await link.focus();
          await expect(link).toBeFocused();
          await page.keyboard.press('Enter');
          await page.waitForURL(url => url.pathname === '/deals' && url.searchParams.get('deal') === id);
          await expect(page.locator('#recordPanel')).toBeVisible();
          await expect(page.locator('#recordPanel .deal-opening-snapshot')).toBeVisible();
          await expect(page.locator('#recordPanel')).toContainText(label);
          await expect.poll(() => roomReads.slice(before)).toContain(id);
          assert.deepEqual([...new Set(roomReads.slice(before))], [id], `only ${id} was opened`);
          await page.goBack();
          await expect(page).toHaveURL(calendarUrl);
          await expect(page.locator('#calStatusLabel')).toHaveText('Current');
          await expect(page.locator('#calPeriod')).toHaveText(period);
          await expect(page.locator('.cal-day[aria-selected="true"]')).toHaveAttribute('data-day', '2026-10-20');
          await expect(page.locator('#calUndatedList')).toContainText('Date unavailable');
        }
        assert.equal(calls.includes('add-critical-date'), false);
        empty = true;
        await page.locator('#calRefresh').click();
        await expect(page.locator('#calState')).toContainText('No deal carries a critical date yet');
        await expect(links).toHaveCount(0);
        empty = false;
        missingDestination = true;
        await page.locator('#calRefresh').click();
        await expect(page.locator('#calUndatedList li')).toHaveCount(1);
        await expect(page.locator('#calUndatedList')).toContainText('Date unavailable');
        await expect(links).toHaveCount(0);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
});
