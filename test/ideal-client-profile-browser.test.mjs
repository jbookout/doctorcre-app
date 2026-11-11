import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
const board = JSON.parse(await readFile(new URL('./fixtures/charts-synthetic.json', import.meta.url)));
board.deals.push({ ...board.deals[0], id: 'synthetic-open', name: 'Synthetic open case', phase: 'research', outcome: null },
  { ...board.deals[0], id: 'synthetic-lost', name: 'Synthetic lost case', phase: 'closed', outcome: 'lost' });
const snapshot = () => ({ schema_version: 'ideal-client-profile.v1', coverage: 'recorded_closed_won_only', profiles: [
  { vertical: 'Dental', deal_type: 'lease', city: 'Demo City', state: 'TX', won_deals: 2, clients: 1,
    evidence: [{ deal_id: '00000000-0000-4000-8000-000000000001', closed_on: '2025-02-01' }, { deal_id: '00000000-0000-4000-8000-000000000002', closed_on: '2025-03-01' }], hypothesis: 'Historical fit, not a prediction or qualification rule.' },
  { vertical: null, deal_type: 'purchase', city: null, state: null, won_deals: 1, clients: 1,
    evidence: [{ deal_id: '00000000-0000-4000-8000-000000000003', closed_on: '2025-04-01' }], hypothesis: 'Historical fit, not a prediction or qualification rule.' },
] });
for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`historical fit is lazy, evidenced and clear at ${width} ${theme}`, async t => {
    const server = await startFixtureServer(); t.after(() => server.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    let reads = [], boardReads = 0, mode = 'ready', held;
    await page.route(/\/(?:auth\/session|api\/system-work\/session)$/, route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-session' } }));
    await page.route('**/mcp', async route => {
      const req = route.request().postDataJSON();
      const name = req.params.name;
      let payload = {};
      if (name === 'deal-room-board') { boardReads++; payload = board; }
      if (name === 'ideal-client-profile') {
        reads.push(req.params.arguments);
        const delayed = req.params.arguments.city === 'Delayed';
        if (delayed) await new Promise(resolve => held = resolve);
        payload = snapshot();
        if (delayed) payload.profiles[0].city = 'Stale response';
        if (mode === 'empty') payload.profiles = [];
        if (mode === 'overflow') payload = { error: 'client_profile_limit_exceeded' };
        if (mode === 'refused') payload = { error: 'forbidden' };
        if (mode === 'invalid') payload.coverage = 'all_deals';
        if (mode === 'invalid-date') payload.profiles[0].evidence[0].closed_on = '2026-02-31';
      }
      return route.fulfill({ json: { jsonrpc: '2.0', id: req.id, result: { isError: Boolean(payload.error), content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
    });
    await page.goto(`${server.url}/?view=charts&mode=live`);
    await page.locator('#chartAccounts tbody tr').first().waitFor();
    const buckets = await page.locator('#chartsCanvas').innerText();
    const region = page.getByRole('region', { name: 'Historical client fit', exact: true });
    assert.equal(await region.count(), 1);
    assert.equal(reads.length, 0);
    const summary = region.locator('summary').first();
    await summary.focus(); await page.keyboard.press('Enter');
    await region.getByText('Dental', { exact: true }).waitFor();
    assert.equal(reads.length, 1);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SUMMARY');
    const dental = region.getByRole('row').filter({ hasText: 'Dental' });
    assert.match(await dental.innerText(), /2 deals/);
    assert.match(await dental.innerText(), /1 client/);
    assert.match(await region.innerText(), /Unrecorded/);
    assert.doesNotMatch(await region.innerText(), /Synthetic open case|Synthetic lost case/);
    assert.equal(await region.getByRole('row').count(), 3, 'only the two server profile groups, regardless of open or lost board records');
    assert.match(await region.innerText(), /Historical fit, not a prediction or qualification rule/);
    await dental.locator('summary').click();
    assert.equal(await dental.getByRole('link').count(), 2);
    const evidence = dental.getByRole('link').first();
    assert.equal(await evidence.getAttribute('href'), '/deals?deal=00000000-0000-4000-8000-000000000001');
    assert.match(await evidence.innerText(), /2025-02-01/);
    await evidence.click();
    assert.equal(new URL(page.url()).searchParams.get('deal'), '00000000-0000-4000-8000-000000000001');
    await page.goBack();
    await region.locator('summary').first().click();
    await region.getByText('Dental', { exact: true }).waitFor();
    await region.getByRole('row').filter({ hasText: 'Dental' }).locator('summary').click();
    assert.equal(await region.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.deepEqual(await page.locator('#chartsCanvas > *').evaluateAll(cards => cards.filter(card => card.getBoundingClientRect().right > innerWidth).map(card => card.id)), []);
    const documentScroll = await page.evaluate(() => {
      window.scrollTo({ left: 100, behavior: 'instant' });
      return { viewport: window.innerWidth, pageWidth: document.documentElement.scrollWidth, pageScrollX: window.scrollX };
    });
    assert.ok(documentScroll.pageWidth <= documentScroll.viewport, JSON.stringify(documentScroll));
    assert.equal(documentScroll.pageScrollX, 0, 'Charts cannot scroll the document sideways');
    await mkdir('/tmp/WR647.S1.J42-ui', { recursive: true });
    await region.locator('.chart-scroll').evaluate(el => { el.scrollLeft = 0; });
    await region.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/WR647.S1.J42-ui/${width}-${theme}.png` });
    await region.getByLabel('City', { exact: true }).fill('Delayed');
    const delayed = page.waitForRequest(req => req.url().endsWith('/mcp') && req.postData()?.includes('Delayed'));
    await region.getByRole('button', { name: 'Apply filters' }).click(); await delayed;
    await region.getByLabel('City', { exact: true }).fill('Demo City');
    await region.getByLabel('State', { exact: true }).fill('TX');
    await region.getByLabel('Vertical', { exact: true }).fill('Dental');
    await region.getByRole('button', { name: 'Apply filters' }).click();
    await region.getByText('Dental', { exact: true }).waitFor();
    const delayedReply = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postData()?.includes('Delayed'));
    held(); await (await delayedReply).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.doesNotMatch(await region.innerText(), /Stale response/);
    assert.deepEqual(reads.at(-1), { city: 'Demo City', state: 'TX', vertical: 'Dental' });
    assert.equal(await page.locator('#chartsCanvas').innerText(), buckets);
    mode = 'overflow'; await region.getByRole('button', { name: 'Refresh history' }).click();
    await region.getByRole('alert').waitFor(); assert.match(await region.innerText(), /Narrow.*filters/);
    assert.equal(await region.getByRole('table').count(), 0);
    mode = 'invalid-date'; await region.getByRole('button', { name: 'Refresh history' }).click();
    await region.getByRole('alert').waitFor(); assert.equal(await region.getByRole('table').count(), 0);
    assert.match(await region.innerText(), /Historical client fit unavailable/);
    mode = 'invalid'; await region.getByRole('button', { name: 'Refresh history' }).click();
    await region.getByRole('alert').waitFor(); assert.equal(await region.getByRole('table').count(), 0);
    mode = 'empty'; await region.getByRole('button', { name: 'Refresh history' }).click();
    await region.getByText('No completed wins match these filters. No historical client profile can be inferred.').waitFor();
    mode = 'ready'; await region.getByRole('button', { name: 'Refresh history' }).click();
    await region.getByText('Dental', { exact: true }).waitFor();
    assert.equal(boardReads, 2, 'one board read per visit; profile filters do not read the board');
    mode = 'refused'; await region.getByRole('button', { name: 'Refresh history' }).click();
    await page.waitForURL('**/public-shell/session-ended.html');
    assert.doesNotMatch(await page.locator('body').innerText(), /Demo City/);
    assert.deepEqual(errors, []);
    mode = 'ready'; await page.goto(`${server.url}/?view=charts&mode=live`);
    await region.locator('summary').first().click();
    await region.getByText('Dental', { exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    assert.equal(await region.getByRole('table').count(), 0);
    assert.doesNotMatch(await region.innerText(), /Demo City/);
  });
}
