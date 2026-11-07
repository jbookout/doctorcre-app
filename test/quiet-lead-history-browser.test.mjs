import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { validateQuietFollowUps } from '../js/leads-client.js';

const snapshot = validateQuietFollowUps(JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url))));
const leads = snapshot.proposals.filter(row => row.subject_type === 'lead');
for (const width of [390, 1440]) test(`history intersects owner search and pages without RPC at ${width}`, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(3000);
  await routeLeads(page);
  let reads = 0, refused = false;
  await page.route('**/mcp', (route, request) => {
    if (request.postDataJSON()?.params?.name !== 'quiet-follow-ups') return route.fallback();
    reads++;
    return refused ? route.fulfill({ json: { result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'unavailable' }) }] } } }) : route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(snapshot) }] } } });
  });
  await page.goto('http://localhost/leads');
  const section = page.locator('#quietFollowUps');
  const history = section.getByRole('combobox', { name: 'Contact history', exact: true });
  const owner = section.getByRole('combobox', { name: 'Quiet lead owner', exact: true });
  const search = section.getByRole('searchbox');
  await history.waitFor();
  assert.deepEqual(await history.locator('option').evaluateAll(nodes => nodes.map(n => [n.value, n.textContent])), [['all', 'All contact history'], ['created_at', 'No contact recorded'], ['last_contact', 'Contact recorded']]);
  const check = async (rows, offset = 0) => {
    assert.deepEqual(await section.locator('[data-quiet-lead]').evaluateAll(nodes => nodes.map(n => n.dataset.quietLead)), rows.slice(offset, offset + 10).map(row => row.subject_id));
    assert.equal(await section.getByRole('status').innerText(), rows.length ? `Showing ${offset + 1}–${Math.min(offset + 10, rows.length)} of ${rows.length} matching loaded leads (${leads.length} loaded).` : `0 matching loaded leads (${leads.length} loaded).`);
  };
  const initialReads = reads;
  const baseline = await section.locator('[data-quiet-lead]').evaluateAll(nodes => nodes.map(n => [n.dataset.quietLead, n.textContent, n.getAttribute('href')]));
  for (const basis of ['created_at', 'last_contact', 'all']) {
    await history.selectOption(basis);
    const rows = leads.filter(row => basis === 'all' || row.basis === basis);
    assert.ok(rows.length > 0);
    await check(rows);
    if (rows.length > 10) {
      await section.getByRole('button', { name: 'Next leads', exact: true }).click();
      await check(rows, 10);
      await section.getByRole('button', { name: 'Previous leads', exact: true }).click(); await check(rows);
    }
  }
  assert.deepEqual(await section.locator('[data-quiet-lead]').evaluateAll(nodes => nodes.map(n => [n.dataset.quietLead, n.textContent, n.getAttribute('href')])), baseline);
  await history.selectOption('last_contact');
  await owner.selectOption('owner:joe');
  await search.fill('L-SYNTH-2');
  await check(leads.filter(row => row.basis === 'last_contact' && row.owner === 'joe' && row.ref.toLowerCase().includes('l-synth-2')));
  await search.fill('no such lead'); await check([]);
  await section.getByText('No quiet leads match this contact history, search and owner.', { exact: true }).waitFor();
  await section.getByRole('button', { name: 'Clear search', exact: true }).click();
  assert.equal(await history.inputValue(), 'last_contact'); assert.equal(await owner.inputValue(), 'owner:joe');
  await check(leads.filter(row => row.basis === 'last_contact' && row.owner === 'joe'));
  await owner.selectOption('all');
  await section.getByRole('button', { name: 'Next leads', exact: true }).click();
  await history.selectOption('created_at'); await check(leads.filter(row => row.basis === 'created_at'));
  await history.selectOption('last_contact');
  await section.getByRole('button', { name: 'Next leads', exact: true }).click();
  await search.fill('Quiet'); await check(leads.filter(row => row.basis === 'last_contact'));
  await section.getByRole('button', { name: 'Next leads', exact: true }).click();
  await owner.selectOption('owner:joe'); await check(leads.filter(row => row.basis === 'last_contact' && row.owner === 'joe'));
  assert.equal(reads, initialReads);
  await owner.selectOption('all');
  await section.getByRole('button', { name: 'Next leads', exact: true }).click();
  await check(leads.filter(row => row.basis === 'last_contact'), 10);
  await section.getByRole('button', { name: 'Clear search', exact: true }).click();
  await check(leads.filter(row => row.basis === 'last_contact'));
  assert.equal(await history.inputValue(), 'last_contact');
  await section.getByRole('button', { name: 'Next leads', exact: true }).click();
  await check(leads.filter(row => row.basis === 'last_contact'), 10);
  assert.equal(reads, initialReads);
  await page.locator('#refreshBoard').click(); await history.waitFor();
  assert.equal(await history.inputValue(), 'last_contact'); await check(leads.filter(row => row.basis === 'last_contact'));
  refused = true; await page.locator('#refreshBoard').click(); await section.getByRole('alert').waitFor();
  assert.equal(await section.locator('[data-quiet-lead]').count(), 0);
  refused = false; await page.locator('#refreshBoard').click(); await history.waitFor();
  assert.equal(await history.inputValue(), 'last_contact');
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await history.count(), 0);
  await page.locator('#refreshBoard').click(); await history.waitFor(); assert.equal(await history.inputValue(), 'all');
  assert.equal(await section.evaluate(n => n.scrollWidth <= n.clientWidth), true);
});

test('history lifecycle clears idle and disposal, hides loading and refusal, retains selection on retry', async t => {
  const code = await build({ entryPoints: ['src/ui/quiet-leads.tsx'], bundle: true, write: false, format: 'iife', globalName: 'Quiet', jsx: 'automatic' });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(3000);
  await page.setContent('<div id="host"></div>'); await page.addScriptTag({ content: code.outputFiles[0].text });
  await page.evaluate(snapshot => {
    window.view = Quiet.mountQuietLeads(document.getElementById('host'), row => row.basis);
    window.snapshot = snapshot; view.update({ kind: 'ready', snapshot });
  }, snapshot);
  const history = page.getByRole('combobox', { name: 'Contact history', exact: true });
  for (const from of ['ready', 'loading', 'refused', 'idle']) {
    await page.evaluate(() => view.update({ kind: 'ready', snapshot }));
    await history.selectOption('last_contact');
    await page.evaluate(kind => view.update(kind === 'ready' ? { kind, snapshot } : kind === 'refused' ? { kind, message: 'Unavailable' } : { kind }), from);
    if (from !== 'ready') assert.equal(await page.locator('[data-quiet-lead]').count(), 0);
    await page.evaluate(() => view.update({ kind: 'idle' }));
    await page.evaluate(() => view.update({ kind: 'ready', snapshot }));
    assert.equal(await history.inputValue(), 'all');
  }
  await history.selectOption('last_contact');
  for (const kind of ['loading', 'refused', 'loading']) await page.evaluate(kind => view.update(kind === 'refused' ? { kind, message: 'Unavailable' } : { kind }), kind);
  await page.evaluate(() => view.update({ kind: 'ready', snapshot })); assert.equal(await history.inputValue(), 'last_contact');
  await page.evaluate(() => { view.dispose(); view.dispose(); view.update({ kind: 'ready', snapshot }); });
  assert.equal(await page.locator('#host').innerText(), '');
  for (const kind of ['idle', 'loading', 'refused']) {
    await page.evaluate(kind => {
      window.view = Quiet.mountQuietLeads(document.getElementById('host'), row => row.basis);
      view.update({ kind: 'ready', snapshot });
      view.update(kind === 'refused' ? { kind, message: 'Unavailable' } : { kind });
      view.dispose(); view.update({ kind: 'ready', snapshot });
    }, kind);
    assert.equal(await page.locator('#host').innerText(), '', `disposal from ${kind} rejects late rows`);
  }
});
