import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect as baseExpect } from '@playwright/test';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { invoiceTrackerFixture } from '../js/invoice-tracker-fixture.js';
import { chromium, WAIT_MS } from './browser-harness.mjs';

const expect = baseExpect.configure({ timeout: WAIT_MS });
const root = fileURLToPath(new URL('../', import.meta.url));

test('invoice details open the owning deal without recording payment', async t => {
  const outDir = await temporaryDirectory('invoice-deal-link-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  const { server } = await createQaServer({ buildRoot: join(outDir, 'site') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) await t.test(`${width} ${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const calls = [], errors = [];
    const data = invoiceTrackerFixture('2026-10-02');
    data.entries = [data.entries[0], data.entries[1], data.entries[4], data.entries[5]];
    data.entries.forEach((row, i) => { row.deal_id = ['qa-deal-1', 'qa-deal-1', 'qa-deal-2', 'qa-deal-3'][i]; });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'doctorcre-app-staging.joe-bookout-carr-us.workers.dev') return route.abort();
      const req = url.pathname === '/mcp' ? route.request().postDataJSON().params : null;
      if (req) calls.push(req.name);
      if (req?.name === 'read-invoice-tracker') return route.fulfill({ json: { result: { content: [{ text: JSON.stringify(data) }] } } });
      const response = await page.request.fetch(`${origin}${url.pathname}${url.search}`, {
        method: route.request().method(), data: route.request().postData() ?? undefined,
        headers: { 'content-type': 'application/json' },
      });
      return route.fulfill({ response });
    });
    try {
      await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `invoice-deal-${width}-${theme}`, reset: true } });
      await page.goto('https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev/invoices');
      await expect(page.locator('[data-invoice]')).toHaveCount(4);
      for (const [i, row] of data.entries.entries()) {
        const key = row.commission_id || 'awaiting:qa-deal-3';
        const opener = page.locator(`[data-invoice="${key}"]`);
        const reads = calls.filter(name => name === 'read-invoice-tracker').length;
        await opener.click();
        const link = page.getByRole('link', { name: 'Open deal', exact: true });
        await expect(link).toHaveAttribute('href', i < 2 ? '/deals?deal=qa-deal-1' : i === 2 ? '/deals?deal=qa-deal-2' : '/deals?deal=qa-deal-3');
        const appearance = await link.evaluate(node => {
          const style = getComputedStyle(node);
          return { color: style.color, height: node.getBoundingClientRect().height };
        });
        assert.notEqual(appearance.color, theme === 'light' ? 'rgb(0, 0, 238)' : 'rgb(158, 158, 255)', 'Open deal uses the app palette');
        assert.ok(appearance.height >= 44, `Open deal has a 44px target, got ${appearance.height}`);
        assert.equal(calls.filter(name => name === 'read-invoice-tracker').length, reads);
        if (i === 0) {
          await page.locator('#invoicePaidDate').fill('2026-10-01');
          await page.locator('#closeInvoiceDetail').focus();
          await page.keyboard.press('Tab');
          await expect(link).toBeFocused();
          data.entries[0].gross_amount = '12501';
          await page.evaluate(() => document.querySelector('#refreshInvoices').click());
          await expect(page.locator('#invoiceDetailFacts')).toContainText('$12,501.00');
          await expect(link).toBeFocused();
          const focus = await link.evaluate(node => {
            const style = getComputedStyle(node);
            return { visible: node.matches(':focus-visible'), style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
          });
          assert.equal(focus.visible, true);
          assert.equal(focus.style, 'solid');
          assert.ok(focus.width >= 2);
          await expect(page.locator('#invoicePaidDate')).toHaveValue('2026-10-01');
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          const box = await page.locator('#invoiceDetail').boundingBox();
          assert.ok(box.width <= width && (width === 390 || box.width > 850));
          const evidence = join(root, 'out/test-artifacts/invoice-deal-link');
          await mkdir(evidence, { recursive: true });
          await page.screenshot({ path: join(evidence, `${width}-${theme}-invoice.png`) });
        }
        await page.locator('#closeInvoiceDetail').click();
        await expect(opener).toBeFocused();
        await opener.click();
        await link.focus();
        await page.keyboard.press('Enter');
        await page.waitForURL(url => url.pathname === '/deals' && url.searchParams.get('deal') === row.deal_id);
        await expect(page.locator('#recordPanel')).toBeVisible();
        await expect(page.locator('#recordPanel .deal-opening-snapshot')).toBeVisible();
        assert.ok(calls.includes('get-deal-room'));
        await page.goBack();
        await expect(page.locator('[data-invoice]')).toHaveCount(4);
        if (await page.locator('#invoiceDetail').isVisible()) await page.locator('#closeInvoiceDetail').click();
      }
      for (const id of ['javascript:alert(1)', '//outside.invalid', ' ', 'bad" onclick="alert(1)', '\u0000']) {
        data.entries[0].deal_id = id;
        const reads = calls.filter(name => name === 'read-invoice-tracker').length;
        await page.locator('#refreshInvoices').click();
        await expect.poll(() => calls.filter(name => name === 'read-invoice-tracker').length).toBeGreaterThan(reads);
        await page.locator(`[data-invoice="${data.entries[0].commission_id}"]`).click();
        await expect(page.getByRole('link', { name: 'Open deal', exact: true })).toHaveCount(0);
        await page.locator('#closeInvoiceDetail').click();
      }
      data.entries[0].deal_id = null;
      await page.reload();
      await expect(page.locator('#invoiceNotice')).toContainText('Invoices temporarily unavailable');
      await expect(page.getByRole('link', { name: 'Open deal', exact: true })).toHaveCount(0);
      assert.equal(calls.includes('record-commission-receipt'), false);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});
