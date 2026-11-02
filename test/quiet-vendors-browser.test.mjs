import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';

const id = '00000000-0000-4000-8000-000000000002';
const snapshot = () => ({ schema_version: 'quiet-follow-ups.v1', cadence: { lead_days: 45, vendor_days: 90 }, sent: false, tasks_created: false,
  proposals: Array.from({ length: 26 }, (_, n) => ({ subject_type: n === 25 ? 'lead' : 'vendor', subject_id: id,
    ref: `V-DEMO-${n}`, name: n === 25 ? 'Hidden lead' : `Quiet vendor ${n + 1} ${'Synthetic long name '.repeat(3)}`,
    owner: 'dell', basis: n % 2 ? 'last_contact' : 'created_at', anchor_on: '2028-01-01', due_on: '2028-03-31', days_overdue: 12 })) });

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`quiet vendors are opt-in, bounded and preserve directory navigation at ${width} ${theme}`, async t => {
    const server = await startFixtureServer();
    t.after(() => server.stop());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('https://**', route => route.abort());
    let reads = 0, response = snapshot(), refuse = false, release = null, onHeld = null;
    await page.route('**/api/v1/business/**', route => route.fulfill({ json: directoryFixture(route.request().url()) }));
    await page.route('**/mcp', async route => {
      const request = route.request().postDataJSON();
      if (request.params.name !== 'quiet-follow-ups') return route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: '{}' }] } } });
      reads++;
      if (release) { onHeld(); await release; }
      return route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: { isError: refuse, content: [{ type: 'text', text: JSON.stringify(refuse ? { error: 'forbidden' } : response) }] } } });
    });
    await page.goto(`${server.url}/clients`);
    await page.locator('.record-row').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Show quiet vendors' }).count(), 0);
    assert.equal(reads, 0);
    await page.goto(`${server.url}/vendors?q=Demo&owner=all`);
    await page.locator('.record-row').first().waitFor();
    const show = page.getByRole('button', { name: 'Show quiet vendors' });
    await show.waitFor();
    assert.equal(reads, 0);
    await show.focus();
    await page.keyboard.press('Enter');
    const section = page.getByRole('region', { name: 'Quiet vendor follow-ups' });
    await section.getByText('Showing 1–20 of 25 quiet vendors.', { exact: true }).waitFor();
    assert.equal(reads, 1);
    assert.equal(await section.getByText('Hidden lead').count(), 0);
    assert.match(await section.innerText(), /Never contacted/);
    assert.match(await section.innerText(), /Last contact/);
    await section.getByRole('button', { name: 'Next vendors' }).click();
    await section.getByText('Showing 21–25 of 25 quiet vendors.', { exact: true }).waitFor();
    assert.equal(reads, 1);
    assert.equal(await section.getByRole('link').count(), 5);
    await section.getByRole('button', { name: 'Previous vendors' }).click();
    assert.equal(await section.getByRole('link').count(), 20);
    await page.locator('#searchInput').fill('Demo Partner');
    await page.locator('#searchInput').press('Enter');
    await section.getByRole('link').first().scrollIntoViewIfNeeded();
    const priorScroll = await page.evaluate(() => window.scrollY);
    const prior = new URL(page.url()).search;
    await section.getByRole('link').first().click();
    await page.locator('#recordPanel.open').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('record'), id);
    assert.equal(new URL(page.url()).searchParams.get('q'), 'Demo Partner');
    await page.goBack();
    assert.equal(new URL(page.url()).search, prior);
    assert.equal(await page.evaluate(() => Math.round(window.scrollY)), Math.round(priorScroll));
    await section.getByRole('button', { name: 'Refresh quiet vendors' }).click();
    await section.getByText('Showing 1–20 of 25 quiet vendors.', { exact: true }).waitFor();
    assert.equal(reads, 2);
    assert.equal(await section.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await mkdir('.github/pr-evidence/WR647.S1.J24', { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `.github/pr-evidence/WR647.S1.J24/${width}-${theme}.png` });
    refuse = true;
    await section.getByRole('button', { name: 'Refresh quiet vendors' }).click();
    await section.getByRole('alert').waitFor();
    assert.doesNotMatch(await section.innerText(), /No quiet vendors/);
    response = { ...snapshot(), proposals: [] }; refuse = false;
    await section.getByRole('button', { name: 'Refresh quiet vendors' }).click();
    await section.getByText('No quiet vendors in this server snapshot.').waitFor();
    let finish;
    release = new Promise(resolve => finish = resolve);
    response = snapshot();
    const beforeLate = reads;
    const lateRequest = new Promise(resolve => onHeld = resolve);
    await section.getByRole('button', { name: 'Refresh quiet vendors' }).click();
    await lateRequest;
    assert.equal(reads, beforeLate + 1);
    await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    finish();
    await page.waitForLoadState('networkidle');
    assert.equal(await section.count(), 0);
  });
}
