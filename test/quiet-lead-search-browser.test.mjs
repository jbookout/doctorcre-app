import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { validateQuietFollowUps } from '../js/leads-client.js';

const original = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
const recording = validateQuietFollowUps({ ...original, proposals: original.proposals.filter(row => row.subject_type === 'lead').slice(0, 25) });
for (const width of [390, 1280]) test(`search intersects owner and pages in server order at ${width}`, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(3000);
  await routeLeads(page);
  let reads = 0;
  await page.route('**/mcp', (route, request) => {
    if (request.postDataJSON()?.params?.name !== 'quiet-follow-ups') return route.fallback();
    reads++;
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(recording) }] } } });
  });
  await page.goto('http://localhost/leads');
  const section = page.locator('#quietFollowUps'), input = section.getByRole('searchbox', { name: 'Search loaded quiet leads', exact: true });
  await input.waitFor();
  await section.getByRole('combobox', { name: 'Quiet lead owner', exact: true }).focus(); await page.keyboard.press('Tab');
  assert.equal(await input.evaluate(n => n === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await section.getByRole('button', { name: 'Clear search', exact: true }).evaluate(n => n === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await section.getByRole('button', { name: 'Previous leads', exact: true }).evaluate(n => n === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await section.getByRole('button', { name: 'Next leads', exact: true }).evaluate(n => n === document.activeElement), true);
  const initial = reads, rows = recording.proposals;
  const links = section.locator('[data-quiet-lead]');
  const baseline = new Map();
  async function check(expected) {
    const seen = [];
    for (let offset = 0; offset < Math.max(1, expected.length); offset += 10) {
      assert.deepEqual(await links.evaluateAll(nodes => nodes.map(n => n.dataset.quietLead)), expected.slice(offset, offset + 10).map(row => row.subject_id));
      const count = expected.length ? `Showing ${offset + 1}–${Math.min(offset + 10, expected.length)} of ${expected.length} matching loaded leads (25 loaded).` : '0 matching loaded leads (25 loaded).';
      assert.equal(await section.getByRole('status').innerText(), count);
      for (const link of await links.all()) {
        const id = await link.getAttribute('data-quiet-lead');
        const value = [await link.getAttribute('href'), await link.innerText()];
        if (baseline.has(id)) assert.deepEqual(value, baseline.get(id)); else baseline.set(id, value);
        seen.push(id);
      }
      if (offset + 10 < expected.length) {
        await section.getByRole('button', { name: 'Next leads', exact: true }).focus(); await page.keyboard.press('Enter');
      }
    }
    assert.equal(new Set(seen).size, expected.length);
  }
  await check(rows);
  await input.focus(); await page.keyboard.insertText('  QUIET LEAD  ');
  await check(rows);
  await section.getByRole('button', { name: 'Previous leads', exact: true }).focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await links.evaluateAll(nodes => nodes.map(n => n.dataset.quietLead)), rows.slice(10, 20).map(row => row.subject_id));
  await section.getByRole('button', { name: 'Previous leads', exact: true }).click();
  assert.deepEqual(await links.evaluateAll(nodes => nodes.map(n => n.dataset.quietLead)), rows.slice(0, 10).map(row => row.subject_id));
  await input.fill('l-sYnTh-2');
  await check(rows.filter(row => row.ref.toLowerCase().includes('l-synth-2')));
  await section.getByRole('combobox', { name: 'Quiet lead owner', exact: true }).selectOption('owner:joe');
  await check(rows.filter(row => row.owner === 'joe' && row.ref.toLowerCase().includes('l-synth-2')));
  await input.fill('Last contact'); await check([]);
  await section.getByText('No quiet leads match this search and owner.', { exact: true }).waitFor();
  await input.fill('.*'); await check([]);
  await input.fill('L-SYNTH-');
  await check(rows.filter(row => row.owner === 'joe'));
  await section.getByRole('button', { name: 'Clear search', exact: true }).focus(); await page.keyboard.press('Enter');
  assert.equal(await input.inputValue(), ''); assert.equal(await input.evaluate(n => n === document.activeElement), true);
  assert.deepEqual(await links.evaluateAll(nodes => nodes.map(n => n.dataset.quietLead)), rows.filter(row => row.owner === 'joe').slice(0, 10).map(row => row.subject_id));
  await input.fill(' QUIET ');
  await section.getByRole('button', { name: 'Next leads', exact: true }).click();
  await page.locator('#refreshBoard').click(); await input.waitFor();
  assert.equal(await input.inputValue(), ' QUIET ');
  assert.match(await section.getByRole('status').innerText(), /^Showing 1–10/);
  assert.equal(reads, initial + 1, 'only explicit refresh reads');
  assert.equal(await section.evaluate(n => n.scrollWidth <= n.clientWidth), true);
  await page.screenshot({ path: `/tmp/WR647.S23.J1-search-${width}.png` });
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await input.count(), 0);
  await page.locator('#refreshBoard').click(); await input.waitFor();
  assert.equal(await input.inputValue(), '');
});

test('idle and dispose clear query and disposed mount ignores late updates', async t => {
  const code = await build({ entryPoints: ['src/ui/quiet-leads.tsx'], bundle: true, write: false, format: 'iife', globalName: 'Quiet', jsx: 'automatic' });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div id="host"></div>');
  await page.addScriptTag({ content: code.outputFiles[0].text });
  await page.evaluate(snapshot => {
    window.view = Quiet.mountQuietLeads(document.getElementById('host'), () => 'Recorded reason');
    window.snapshot = snapshot; view.update({ kind: 'ready', snapshot });
  }, recording);
  const input = page.getByRole('searchbox'); await input.fill('quiet');
  await page.evaluate(() => { view.update({ kind: 'idle' }); view.update({ kind: 'ready', snapshot }); });
  assert.equal(await input.inputValue(), '');
  await input.fill('quiet');
  await page.evaluate(() => view.update({ kind: 'loading' }));
  await page.getByText('Loading follow-ups…', { exact: true }).waitFor();
  await page.evaluate(() => view.update({ kind: 'refused', message: 'Read unavailable' }));
  await page.getByRole('alert').waitFor();
  await page.evaluate(() => { view.update({ kind: 'loading' }); view.update({ kind: 'ready', snapshot }); });
  assert.equal(await input.inputValue(), 'quiet', 'retry retains search');
  await page.evaluate(() => { view.dispose(); view.dispose(); view.update({ kind: 'ready', snapshot }); });
  assert.equal(await page.locator('#host').innerText(), '');
});
