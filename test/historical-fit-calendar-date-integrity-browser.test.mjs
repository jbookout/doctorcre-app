import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { calendarAssertions } from '../scripts/prove-historical-fit-calendar-date-integrity.mjs';

for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) {
  test(`calendar evidence integrity at ${width} ${colorScheme}`, async t => {
    const server = await startFixtureServer(); t.after(() => server.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme, timezoneId: 'America/Los_Angeles' });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), colorScheme);
    await page.goto(server.url);
    await page.evaluate(() => { document.body.replaceChildren(); });
    assert.equal((await calendarAssertions(page, `${server.url}/js/ui-ideal-client-profile.js`)).length, 7);
    await page.evaluate(async () => {
      const { mountIdealClientProfile } = await import('/js/ui-ideal-client-profile.js');
      const host = document.createElement('main'); document.body.append(host);
      mountIdealClientProfile(host, { getIdealClientProfile: async () => ({}) });
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
