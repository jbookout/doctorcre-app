import { admitRecording } from './fixtures/quiet-vendor-basis/producer.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';
import { validateQuietFollowUps } from '../js/leads-client.js';
const meetingRecordings = JSON.parse(readFileSync(new URL('./fixtures/vendor-meetings/recordings.json', import.meta.url)));
const recorded = () => JSON.parse(readFileSync(new URL('./fixtures/quiet-vendor-basis/recordings.json', import.meta.url)));

test('mixed basis variants retain the registered recording shape and parser refusal', async () => {
  const admitted = await admitRecording();
  assert.deepEqual(admitted, recorded());
  const base = JSON.parse(readFileSync(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
  validateQuietFollowUps(base);
  assert.deepEqual(validateQuietFollowUps(recorded()), recorded());
  for (const basis of [undefined, null, '', 'inferred']) {
    const bad = recorded(); bad.proposals[0].basis = basis;
    assert.throws(() => validateQuietFollowUps(bad), { code: 'invalid_projection' });
  }
});

for (const width of [390, 1280]) test(`history intersects owner before stable paging and survives refresh ${width}`, async t => {
  const server = await startFixtureServer(); t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(5000);
  let response = recorded(), reads = 0;
  await page.route('https://**', route => route.abort());
  await page.route('**/api/v1/business/**', route => route.fulfill({ json: directoryFixture(route.request().url()) }));
  await page.route('**/mcp', route => {
    const request = route.request().postDataJSON();
    const quiet = request.params.name === 'quiet-follow-ups';
    if (quiet) reads++;
    const payload = quiet ? response : meetingRecordings[request.params.arguments.view];
    return route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(server.url + '/vendors');
  const section = page.getByRole('region', { name: 'Quiet vendor follow-ups' });
  await page.getByRole('button', { name: 'Show quiet vendors' }).click();
  const history = section.getByRole('combobox', { name: 'Contact history', exact: true });
  const owner = section.getByRole('combobox', { name: 'Quiet vendor owner' });
  await history.waitFor();
  assert.deepEqual(await history.locator('option').allTextContents(), ['All contact history', 'Never contacted', 'Previously contacted']);
  const ids = () => section.locator('li[data-vendor-id]').evaluateAll(rows => rows.map(row => row.dataset.vendorId));
  for (const basis of ['all', 'created_at', 'last_contact']) {
    await history.selectOption(basis);
    for (const key of ['all', 'owner:joe', 'owner:dell']) {
      await owner.selectOption(key);
      const expected = response.proposals.filter(row => (basis === 'all' || row.basis === basis) && (key === 'all' || 'owner:' + row.owner === key));
      for (let offset = 0; offset < expected.length; offset += 5) {
        assert.deepEqual(await ids(), expected.slice(offset, offset + 5).map(row => row.subject_id));
        if (offset + 5 < expected.length) await section.getByRole('button', { name: 'Next vendors' }).click();
      }
    }
  }
  assert.equal(reads, 1);
  await owner.selectOption('all'); await history.selectOption('all');
  await section.getByRole('button', { name: 'Next vendors' }).click();
  await history.selectOption('created_at');
  assert.deepEqual(await ids(), response.proposals.filter(row => row.basis === 'created_at').slice(0, 5).map(row => row.subject_id));
  await section.getByRole('button', { name: 'Next vendors' }).click();
  await owner.selectOption('owner:joe');
  assert.deepEqual(await ids(), response.proposals.filter(row => row.basis === 'created_at' && row.owner === 'joe').slice(0, 5).map(row => row.subject_id));
  await section.getByRole('button', { name: 'Hide quiet vendors' }).click();
  await page.getByRole('button', { name: 'Show quiet vendors' }).click();
  assert.equal(await history.inputValue(), 'created_at'); assert.equal(reads, 1);
  response.proposals = response.proposals.filter(row => row.basis === 'last_contact');
  await section.getByRole('button', { name: 'Refresh quiet vendors' }).click();
  await section.getByText('0 matching loaded vendors.', { exact: true }).waitFor();
  await section.getByText('No loaded vendors match these filters.', { exact: true }).waitFor();
  assert.equal(await history.inputValue(), 'created_at');
  assert.equal(await owner.inputValue(), 'owner:joe');
  assert.equal(await section.getByText('No quiet vendors in this server snapshot.').count(), 0);
  response.proposals = response.proposals.filter(row => row.owner === 'dell');
  await section.getByRole('button', { name: 'Refresh quiet vendors' }).click();
  await section.getByText('The selected owner is no longer in this snapshot. Showing all owners.').waitFor();
  assert.equal(await history.inputValue(), 'created_at'); assert.equal(await owner.inputValue(), 'all');
  await history.selectOption('last_contact');
  assert.deepEqual(await ids(), response.proposals.map(row => row.subject_id));
  assert.equal(await section.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.ok((await history.boundingBox()).height >= 44);
  const link = section.getByRole('link').first();
  const id = await link.getAttribute('id');
  await link.click(); await page.keyboard.press('Escape');
  await page.waitForFunction(id => document.activeElement?.id === id, id);
  await section.getByText('Server cadence · 90 days', { exact: true }).waitFor();
  assert.equal(await section.locator('li time').first().getAttribute('datetime'), response.proposals[0].anchor_on);
  response = recorded(); delete response.proposals[0].basis;
  await section.getByRole('button', { name: 'Refresh quiet vendors' }).click();
  await section.getByRole('alert').waitFor(); assert.deepEqual(await ids(), []);
  response = recorded();
  await section.getByRole('button', { name: 'Refresh quiet vendors' }).click();
  await history.waitFor();
  assert.equal(await history.inputValue(), 'last_contact');
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await section.count(), 0);
});

test('disposal retires delayed snapshots and remount starts with all contact history', async t => {
  const server = await startFixtureServer(); t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url + '/vendors');
  await page.evaluate(async snapshot => {
    const { mountQuietVendors } = await import('/js/ui-quiet-vendors.js');
    const host = document.createElement('div'); document.body.append(host);
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const view = mountQuietVendors(host, { load: () => pending, href: () => '/vendors', open: () => {} });
    host.querySelector('button').click(); view.dispose(); finish(snapshot);
    await new Promise(resolve => setTimeout(resolve, 0));
    if (host.childElementCount) throw Error('Disposed mount published delayed snapshot');
    const remount = mountQuietVendors(host, { load: async () => snapshot, href: () => '/vendors', open: () => {} });
    host.querySelector('button').click();
    await new Promise(resolve => setTimeout(resolve, 30));
    const selects = host.querySelectorAll('select');
    if (selects.length !== 2 || selects[1].value !== 'all') throw Error('Remount retained history');
    remount.dispose(); host.remove();
  }, recorded());
});
