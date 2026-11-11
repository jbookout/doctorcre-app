import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { componentDocument, chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { routeLeads } from './leads-browser-fixture.mjs';
import { calendarAssertions } from '../scripts/prove-historical-fit-calendar-date-integrity.mjs';

for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) {
  test(`calendar evidence integrity at ${width} ${colorScheme}`, async t => {
    const server = await startFixtureServer(); t.after(() => server.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme, timezoneId: 'America/Los_Angeles' });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), colorScheme);
    await componentDocument(page, server.url, { dispose: page => page.evaluate(() => window.integrityPanel?.dispose()) });
    await page.evaluate(() => { document.body.replaceChildren(); });
    assert.equal((await calendarAssertions(page, `${server.url}/js/ui-ideal-client-profile.js`)).length, 7);
    await page.evaluate(async () => {
      const { mountIdealClientProfile } = await import('/js/ui-ideal-client-profile.js');
      const host = document.createElement('main'); document.body.append(host);
      window.integrityPanel = mountIdealClientProfile(host, { getIdealClientProfile: async () => ({}) });
    });
    const region = page.getByRole('region', { name: 'Historical client fit', exact: true });
    await region.locator('summary').first().click(); await region.getByRole('alert').waitFor();
    await mkdir('/tmp/WR647.S2.J1-ui', { recursive: true });
    await page.screenshot({ path: `/tmp/WR647.S2.J1-ui/${width}-${colorScheme}.png` });
  });
}

test('Leads remains searchable after malformed historical evidence', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); await routeLeads(page);
  await page.goto('http://localhost/leads');
  await page.locator('#leadBoard[aria-busy="false"]').waitFor();
  const count = await page.locator('#leadBoard .lead-card').count(); assert.ok(count > 0);
  await page.evaluate(async () => {
    const { mountIdealClientProfile } = await import('/js/ui-ideal-client-profile.js');
    const host = document.createElement('div'); document.body.append(host);
    mountIdealClientProfile(host, { getIdealClientProfile: async () => ({ schema_version: 'ideal-client-profile.v1', coverage: 'recorded_closed_won_only', profiles: [
      { vertical: 'Synthetic', deal_type: 'lease', city: null, state: null, won_deals: 1, clients: 1, hypothesis: 'Historical fit', evidence: [{ deal_id: '00000000-0000-4000-8000-000000000001', closed_on: '2026-02-31' }] },
    ] }) });
  });
  const region = page.getByRole('region', { name: 'Historical client fit', exact: true });
  await region.locator('summary').first().click(); await region.getByRole('alert').waitFor();
  assert.equal(await region.getByRole('table').count(), 0);
  await page.locator('#leadSearch').fill('no synthetic lead matches this');
  assert.equal(await page.locator('#leadBoard .lead-card').count(), 0);
  await page.locator('#leadSearch').fill('');
  assert.equal(await page.locator('#leadBoard .lead-card').count(), count);
});

for (const action of ['clear', 'dispose']) for (const state of ['idle', 'loading', 'valid', 'unavailable', 'retrying', 'cleared']) {
  test(`${action} from ${state} removes evidence and ignores late receipts`, async t => {
    const server = await startFixtureServer(); t.after(() => server.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await componentDocument(page, server.url, { dispose: page => page.evaluate(() => window.lifecycle?.mount.dispose()) });
    await page.evaluate(async state => {
      document.body.replaceChildren();
      const { mountIdealClientProfile } = await import('/js/ui-ideal-client-profile.js');
      const host = document.createElement('main'); document.body.append(host);
      const fixture = window.lifecycle = { pending: [], hold: state === 'loading', reads: 0, invalid: ['unavailable', 'retrying'].includes(state) };
      fixture.mount = mountIdealClientProfile(host, { getIdealClientProfile() {
        fixture.reads++;
        const payload = { schema_version: 'ideal-client-profile.v1', coverage: 'recorded_closed_won_only', profiles: [
          { vertical: 'Synthetic', deal_type: 'lease', city: 'Synthetic city', state: 'TX', won_deals: 1, clients: 1,
            hypothesis: 'Historical fit', evidence: [{ deal_id: '00000000-0000-4000-8000-000000000001', closed_on: fixture.invalid ? '2026-02-31' : '2024-02-29' }] },
        ] };
        return fixture.hold ? new Promise(resolve => fixture.pending.push(() => resolve(payload))) : Promise.resolve(payload);
      } });
    }, state);
    const region = page.getByRole('region', { name: 'Historical client fit', exact: true });
    if (state !== 'idle') {
      await region.locator('summary').first().click();
      await region.getByRole(state === 'loading' ? 'status' : ['unavailable', 'retrying'].includes(state) ? 'alert' : 'table').waitFor();
    }
    if (state === 'retrying') {
      await page.evaluate(() => { window.lifecycle.hold = true; window.lifecycle.invalid = false; });
      await region.getByRole('button', { name: 'Refresh history' }).click();
      await region.getByRole('status').waitFor();
    }
    if (state === 'cleared') await page.evaluate(() => window.lifecycle.mount.clear());
    if (state === 'idle') assert.equal(await page.evaluate(() => window.lifecycle.reads), 0);
    await page.evaluate(action => {
      window.lifecycle.mount[action]();
      window.lifecycle.pending.splice(0).forEach(resolve => resolve());
    }, action);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await region.getByRole('table').count(), 0);
    assert.equal(await region.getByRole('alert').count(), 0);
    assert.equal(await region.getByRole('status').count(), 0);
    if (action === 'dispose') {
      assert.equal(await region.count(), 0);
      await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    } else {
      assert.equal(await region.locator('details').first().getAttribute('open'), null);
      await page.evaluate(() => { window.lifecycle.hold = false; window.lifecycle.invalid = false; });
      await region.locator('summary').first().click();
      await region.getByRole('table').waitFor();
      await region.getByText('Wins (1)', { exact: true }).click();
      assert.equal(await region.locator('time').innerText(), '2024-02-29');
      await page.evaluate(() => window.lifecycle.mount.dispose());
    }
    assert.deepEqual(errors, []);
  });
}
