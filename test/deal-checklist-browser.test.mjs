import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, waitForAsync } from './browser-harness.mjs';
const root = new URL('../', import.meta.url);

for (const width of [390, 1280]) test(`deal checklist opens and refreshes in the actual card at ${width}px`, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 960 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
    const file = url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/deals');
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.size > 0);
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js'); const get = state.client.getDeal;
    window.checklistComplete = false;
    state.client.getDeal = async (...args) => ({ ...await get(...args), checklist: {
      schema_version: 'deal-checklist.v1', template_state: 'current',
      due_items: window.checklistComplete ? [] : [{ id: 'demo', status: 'due' }],
      phases: [{ id: 'legal', label: 'Legal / lease', items: [{ id: 'review', label: 'Demo attorney review', status: window.checklistComplete ? 'complete' : 'due', due_on: '2026-10-20', evidence_ref: 'Demo contract clause 3', source: { document: 'deal-room-kit', version: 1 } }] }],
    } });
  });
  await page.locator('.kanban-card[data-id="d14"]').click();
  const checklist = page.locator('.deal-checklist');
  await checklist.locator(':scope > summary').click();
  assert.match(await checklist.textContent(), /1 due/);
  assert.equal(await checklist.locator('input').count(), 0);
  await checklist.locator('[data-checklist-item="review"] summary').click();
  await page.getByLabel('Update', { exact: true }).fill('Demo unsaved update');
  await page.evaluate(() => { window.checklistComplete = true; });
  await page.locator('[data-refresh-detail]').click();
  await page.getByText('Recorded complete', { exact: true }).waitFor();
  assert.equal(await checklist.evaluate(element => element.open), true);
  assert.equal(await checklist.locator('[data-checklist-item="review"] details').evaluate(element => element.open), true, 'refresh preserves evidence disclosure by item ID');
  assert.equal(await page.getByLabel('Update', { exact: true }).inputValue(), 'Demo unsaved update');
  assert.equal(await page.locator('#recordPanel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await mkdir(new URL('out/test-artifacts/deal-checklist/', root), { recursive: true });
  await checklist.scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL(`out/test-artifacts/deal-checklist/${width}.png`, root).pathname, animations: 'disabled' });
  assert.deepEqual(errors, []);
});
