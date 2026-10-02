import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { invoiceTrackerFixture } from '../js/invoice-tracker-fixture.js';
const root = new URL('../', import.meta.url), today = '2026-10-02';
async function open(t, { width = 1440, reducedMotion = 'no-preference', query = '', home = false, receipt = 'ok' } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 960 }, timezoneId: 'UTC', reducedMotion }); page.setDefaultTimeout(6000);
  await page.clock.install({ time: new Date(today + 'T17:00:00Z') });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const data = invoiceTrackerFixture(today); let failed = false, denied = false, reads = 0, writes = 0;
  const routes = JSON.parse(await readFile(new URL('contracts/app-routes.v1.json', root), 'utf8')).routes;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/api/system-work/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ actor: { slug: 'joe', display_name: 'Demo Partner' } }) });
    if (url.pathname === '/mcp') {
      const req = route.request().postDataJSON().params; let response = {};
      if (req.name === 'read-invoice-tracker') {
        reads++; if (denied) return route.fulfill({ status: 401, body: '' }); if (failed) return route.fulfill({ status: 503, body: '' }); response = data;
      } else if (req.name === 'record-commission-receipt') {
        writes++;
        if (receipt === 'conflict') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { isError: true, content: [{ text: JSON.stringify({ error: 'version_conflict' }) }] } }) });
        const row = data.entries.find(row => row.commission_id === req.arguments.commission_id); row.status = 'received'; row.received_on = req.arguments.received_on; row.base_version++;
        if (receipt === 'uncertain') return route.fulfill({ status: 502, body: '' }); response = { ok: true, id: row.commission_id, base_version: row.base_version, received_on: row.received_on };
      } else if (req.name === 'deal-room-board') response = { actor: 'joe', deals: [] };
      else if (req.name === 'lead-board') response = { leads: [] };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { content: [{ text: JSON.stringify(response) }] } }) });
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ contentType: 'application/json', body: '{}' });
    const file = routes[url.pathname] || url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`http://localhost/${home ? '' : 'invoices'}?mode=live${query}`);
  await page.waitForFunction(home ? () => document.querySelector('#homeInvoices a[data-home-key]') : () => document.querySelectorAll('[data-invoice]').length === 6);
  return { page, errors, get reads() { return reads; }, get writes() { return writes; }, setFailed(value) { failed = value; }, setDenied(value) { denied = value; }, update(fn) { fn(data); } };
}
for (const width of [1440, 390, 320]) test(`invoice layout and wide detail at ${width}px`, async t => {
  const { page, errors } = await open(t, { width }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.app-layout-sidebar #invoiceSearch').count(), 1);
  await page.locator('[data-invoice]').first().click(); await page.waitForFunction(() => document.querySelector('#invoiceDetail').open);
  const box = await page.locator('#invoiceDetail').boundingBox(); assert.ok(box.width <= width); if (width === 1440) assert.ok(box.width > 850);
  await page.locator('#invoiceOriginal summary').click();
  await mkdir(new URL('test-artifacts/w15/', root), { recursive: true }); await page.screenshot({ path: new URL(`test-artifacts/w15/detail-${width}.png`, root).pathname });
  await page.locator('#closeInvoiceDetail').click(); assert.ok(await page.locator('[data-invoice]').first().evaluate(node => node === document.activeElement));
  await page.screenshot({ path: new URL(`test-artifacts/w15/invoices-${width}.png`, root).pathname });
  await page.locator('[data-status="awaiting"]').click(); assert.equal(await page.locator('[data-invoice]').count(), 1); await page.locator('[data-invoice]').click(); assert.match(await page.locator('#invoiceDetailFacts').innerText(), /Awaiting invoice/); assert.equal(await page.locator('#invoicePayment').isVisible(), false);
  await page.locator('#closeInvoiceDetail').click(); await page.locator('[data-status="unpaid"]').click(); await page.locator('[data-invoice]').first().click(); await page.locator('#invoicePaidDate').fill('2026-10-01'); await page.locator('#markInvoicePaid').click(); await page.waitForFunction(() => /Paid/.test(document.querySelector('#invoiceDetailFacts').textContent)); assert.equal(await page.locator('#invoicePayment').isVisible(), false); assert.deepEqual(errors, []);
});
test('filters, aging and automatic refresh preserve drafts and recover failed data', async t => {
  const h = await open(t), page = h.page;
  await page.locator('#invoiceSearch').fill('Cedar'); await page.locator('[data-invoice]').click(); await page.locator('#invoicePaidDate').fill('2026-09-30'); await page.locator('#invoiceOriginal summary').click();
  h.update(data => { data.entries.find(row => row.name === 'Demo Cedar Expansion').gross_amount = '10000'; }); const reads = h.reads; await page.clock.runFor(31000); await page.waitForFunction(() => /10,000/.test(document.querySelector('#invoiceDetailFacts').textContent)); assert.ok(h.reads > reads); assert.equal(await page.locator('#invoicePaidDate').inputValue(), '2026-09-30'); assert.equal(await page.locator('#invoiceOriginal').getAttribute('open'), '');
  await page.locator('#closeInvoiceDetail').click(); await page.locator('#clearInvoiceFilters').click(); await page.locator('#invoiceAging [data-age="2"]').click(); assert.equal(await page.locator('[data-invoice]').count(), 1); assert.match(await page.locator('[data-invoice]').innerText(), /Bay/); await page.locator('#allAges').click(); assert.equal(await page.locator('[data-invoice]').count(), 4);
  h.setFailed(true); await page.locator('#refreshInvoices').click(); await page.waitForFunction(() => !document.querySelector('#invoiceNotice').hidden); assert.equal(await page.locator('[data-invoice]').count(), 4); assert.match(await page.locator('#invoiceUpdated').innerText(), /Updated/);
  h.setFailed(false); await page.clock.runFor(31000); await page.waitForFunction(() => document.querySelector('#invoiceNotice').hidden); assert.deepEqual(h.errors, []);
});
test('uncertain receipt reconciles without another write; conflict keeps the draft', async t => {
  const h = await open(t, { receipt: 'uncertain' }); await h.page.locator('[data-invoice]').first().click(); await h.page.locator('#markInvoicePaid').click(); await h.page.waitForFunction(() => /Paid/.test(document.querySelector('#invoiceDetailFacts').textContent)); assert.equal(h.writes, 1);
  const c = await open(t, { receipt: 'conflict' }); await c.page.locator('[data-invoice]').first().click(); await c.page.locator('#invoicePaidDate').fill('2026-09-30'); await c.page.locator('#markInvoicePaid').click(); await c.page.waitForFunction(() => /Invoice changed/.test(document.querySelector('#invoicePaymentNotice').textContent)); assert.equal(await c.page.locator('#invoicePaidDate').inputValue(), '2026-09-30'); assert.equal(c.writes, 1); assert.equal(await c.page.locator('#markInvoicePaid').isDisabled(), false);
});
test('Home attention shares invoice identity, scope and refreshed paid state', async t => {
  const h = await open(t, { home: true }), page = h.page; assert.equal(await page.locator('#homeInvoices [data-home-key]').count(), 3);
  await page.locator('[data-scope="mine"]').click(); assert.equal(await page.locator('#homeInvoices [data-home-key]').count(), 2);
  h.update(data => { for (const row of data.entries) if (row.owner === 'joe' && row.status === 'invoiced') { row.status = 'received'; row.received_on = today; } });
  await page.clock.runFor(31000); await page.waitForFunction(() => document.querySelector('#homeInvoices').hidden); await page.locator('[data-scope="team"]').click(); assert.equal(await page.locator('#homeInvoices [data-home-key]').count(), 1); assert.deepEqual(h.errors, []);
  await page.screenshot({ path: new URL('test-artifacts/w15/home-attention-1440.png', root).pathname });
});
test('deep link, reduced motion and authentication loss keep the screen contract', async t => {
  const h = await open(t, { width: 390, reducedMotion: 'reduce', query: '&invoice=00000000-0000-4000-8000-000000000002' }); await h.page.waitForFunction(() => document.querySelector('#invoiceDetail').open); assert.equal(await h.page.locator('#invoiceDetailTitle').innerText(), 'Demo Oak Purchase');
  await h.page.locator('#closeInvoiceDetail').click(); assert.equal(await h.page.locator('.invoice-row.overdue .invoice-state').first().evaluate(node => getComputedStyle(node, '::before').animationName), 'none');
  await h.page.screenshot({ path: new URL('test-artifacts/w15/reduced-motion-390.png', root).pathname }); h.setDenied(true); await h.page.locator('#refreshInvoices').click(); await h.page.waitForFunction(() => document.querySelector('#invoiceNotice a')); assert.equal(await h.page.locator('[data-invoice]').count(), 0); assert.deepEqual(h.errors, []);
});
for (const width of [1440, 390]) test(`Home invoice attention fits ${width}px`, async t => {
  const h = await open(t, { home: true, width });
  const overflow = await h.page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].filter(node=>node.getBoundingClientRect().right>innerWidth+1).map(node=>({id:node.id,cls:String(node.className),right:node.getBoundingClientRect().right})).slice(0,12)}));
  await h.page.screenshot({ path: new URL(`test-artifacts/w15/home-attention-${width}.png`, root).pathname });
  assert.ok(overflow.scroll<=overflow.width, JSON.stringify(overflow));
  await h.page.screenshot({ path: new URL(`test-artifacts/w15/home-attention-${width}.png`, root).pathname });
  assert.deepEqual(h.errors, []);
});
