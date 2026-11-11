import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { workspace } from './leads-workspace-fixture.mjs';
const evidence = (condition, current = true) => ({ flag_id: condition, condition, source: `Synthetic ${condition} source`, observed_at: '2028-01-01T12:00:00Z', expires_on: '2028-04-01', expired: !current, current });
const snapshot = () => ({ schema_version: 'territory-state-board.v1', coverage: 'recorded_geographies_only', submarkets: [
  { city: 'Tight City', state: 'TX', condition: 'tight', evidence: [evidence('tight')] },
  { city: 'Soft City', state: 'TX', condition: 'soft', evidence: [evidence('soft')] },
  { city: 'Unknown City', state: 'TX', condition: 'unknown', evidence: [] },
  { city: 'Expired City', state: 'TX', condition: 'unknown', evidence: [evidence('tight', false)] },
  { city: 'Conflict City', state: 'TX', condition: 'conflicting', evidence: [evidence('tight'), evidence('soft')] },
] });
for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`territory evidence at ${width} ${theme}`, async t => {
    const server = await startFixtureServer(); t.after(() => server.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('https://**', route => route.abort());
    let reads = [], refuse = false, held, empty = false;
    await page.route('**/api/system-work/session', route => route.fulfill({ json: { actor: { slug: 'synthetic-partner' } } }));
    await page.route('**/mcp', async route => {
      const req = route.request().postDataJSON();
      if (req.params.name !== 'territory-state-board') return route.fulfill({ json: { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(req.params.name === 'lead-board' ? workspace() : {}) }] } } });
      reads.push(req.params.arguments);
      if (req.params.arguments.city === 'Delayed') await new Promise(resolve => held = resolve);
      const board = empty ? { ...snapshot(), submarkets: [] } : snapshot();
      if (req.params.arguments.city === 'Delayed') board.submarkets = [{ city: 'Stale response', state: 'TX', condition: 'soft', evidence: [] }];
      await route.fulfill({ json: { jsonrpc: '2.0', id: req.id, result: { isError: refuse, content: [{ type: 'text', text: JSON.stringify(refuse ? { error: 'territory_board_limit_exceeded' } : board) }] } } });
    });
    await page.goto(`${server.url}/leads`);
    const region = page.getByRole('region', { name: 'Recorded territory conditions' });
    await region.waitFor();
    await page.locator('#leadBoard[aria-busy="false"]').waitFor();
    const counts = await page.locator('#leadCount').innerText();
    assert.equal(reads.length, 0);
    assert.equal(await page.locator('#territoryMap').isVisible(), false);
    await region.locator('summary').first().focus(); await page.keyboard.press('Enter');
    await region.getByRole('cell', { name: 'Soft', exact: true }).waitFor();
    assert.equal(reads.length, 1);
    for (const [city, condition] of [['Tight City', 'Tight'], ['Soft City', 'Soft'], ['Unknown City', 'Unknown'], ['Expired City', 'Unknown'], ['Conflict City', 'Conflicting']]) {
      assert.match(await region.getByRole('row').filter({ hasText: city }).innerText(), new RegExp(condition));
    }
    const expired = region.getByRole('row').filter({ hasText: 'Expired City' });
    await expired.locator('summary').click(); assert.match(await expired.innerText(), /Historical.*expired/);
    const conflict = region.getByRole('row').filter({ hasText: 'Conflict City' });
    await conflict.locator('summary').click();
    assert.match(await conflict.innerText(), /Synthetic tight source/); assert.match(await conflict.innerText(), /Synthetic soft source/);
    assert.equal(await page.locator('#leadCount').innerText(), counts);
    assert.equal(await page.locator('#territoryMap').isVisible(), false);
    assert.equal(await region.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await mkdir('/tmp/WR647.S1.J39-ui', { recursive: true });
    await region.locator('summary').first().focus();
    await region.evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `/tmp/WR647.S1.J39-ui/${width}-${theme}.png` });
    await region.getByLabel('City', { exact: true }).fill('Delayed');
    const delayed = page.waitForRequest(req => req.url().endsWith('/mcp') && req.postData()?.includes('Delayed'));
    await region.getByRole('button', { name: 'Apply filters' }).click(); await delayed;
    await region.getByLabel('City', { exact: true }).fill('Demo City');
    await region.getByLabel('State', { exact: true }).fill('TX');
    await region.getByRole('button', { name: 'Apply filters' }).click();
    await region.getByRole('cell', { name: 'Soft', exact: true }).waitFor(); held?.();
    await page.waitForLoadState('networkidle');
    assert.doesNotMatch(await region.innerText(), /Stale response/);
    assert.deepEqual(reads.at(-1), { city: 'Demo City', state: 'TX' });
    refuse = true;
    await region.getByRole('button', { name: 'Refresh evidence' }).click();
    await region.getByRole('alert').waitFor(); assert.match(await region.innerText(), /Narrow.*filters/);
    assert.equal(await region.getByRole('table').count(), 0);
    refuse = false; empty = true;
    await region.getByRole('button', { name: 'Refresh evidence' }).click();
    await region.getByText('No loaded areas match this condition. No market condition can be inferred.').waitFor();
    empty = false;
    await region.getByRole('button', { name: 'Refresh evidence' }).click();
    await region.getByRole('cell', { name: 'Soft', exact: true }).waitFor();
    await region.getByRole('row').filter({ hasText: 'Conflict City' }).locator('summary').click();
    assert.match(await region.innerText(), /Synthetic tight source/);
    await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    assert.doesNotMatch(await region.innerText(), /Synthetic tight source/);
  });
}
