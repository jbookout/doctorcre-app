import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, componentDocument } from './browser-harness.mjs';
const recordings = JSON.parse(await readFile('test/fixtures/mail-priority-panel/recordings.json'));
const producer = await import('data:text/javascript;base64,' + Buffer.from(await readFile('test/fixtures/mail-priority-panel/producer.txt')).toString('base64'));
let bundle;
before(async () => {
  bundle = (await build({ stdin: { contents: `export {createRoot} from 'react-dom/client'; export {createElement} from 'react'; export {MailPriorities,parseMailPage} from './src/ui/home/mail-priorities';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm' })).outputFiles[0].text;
});
async function open(t, count) {
  const response = structuredClone(count ? recordings.ready : recordings.empty);
  response.items = response.items.slice(0, count);
  producer.parseMailNeedsPartnerResponse(response);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await componentDocument(page, 'http://localhost', { html: '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="panel"></div>', dispose: p => p.evaluate(() => window.root.unmount()) });
  await page.route('**/panel.js', route => route.fulfill({ body: bundle, contentType: 'text/javascript' }));
  await page.evaluate(async response => {
    const { createRoot, createElement, MailPriorities, parseMailPage } = await import('/panel.js');
    window.root = createRoot(document.getElementById('panel'));
    window.calls = 0; window.reviews = 0; window.pending = false; window.failure = null;
    window.read = async () => { window.calls++; if (window.pending) await new Promise(resolve => window.release = resolve); if (window.failure) throw window.failure; return parseMailPage(response); };
    const items = response.items.map(row => ({ source_type: 'email_proposal', source_id: row.proposal_id, item_id: row.proposal_id, title: 'Review the recorded mail decision and its complete representative title with details for the partner', review_reference: { kind: 'next_step' } }));
    window.render = locked => window.root.render(createElement(MailPriorities, { items, locked, read: window.read, review: (_, opener) => { window.reviews++; window.opener = opener; window.render(true); } }));
    window.render(false);
  }, response);
  await page.getByRole('button', { name: 'Refresh mail priorities' }).waitFor();
  return page;
}
for (const count of [0, 1, 5, 6, 25]) test(`ranked local pages ${count}`, async t => {
  const page = await open(t, count);
  const seen = [];
  for (let offset = 0; offset < Math.max(1, count); offset += 5) {
    const rows = page.locator('[data-mail-proposal]');
    assert.equal(await rows.count(), Math.min(5, count - offset));
    if (count) assert.equal(await page.locator('[data-mail-range]').textContent(), `Decisions ${offset + 1}–${Math.min(offset + 5, count)} of ${count} loaded`);
    else assert.equal(await page.locator('[data-mail-range]').count(), 0);
    seen.push(...await rows.evaluateAll(nodes => nodes.map(n => n.dataset.mailProposal)));
    assert.ok(await page.getByRole('region', { name: 'Mail priorities' }).evaluate(n => n.getBoundingClientRect().height < 1600));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (offset + 5 < count) await page.getByRole('button', { name: 'Next mail', exact: true }).click();
  }
  assert.deepEqual(seen, recordings.ready.items.slice(0, count).map(row => row.proposal_id));
  assert.equal(await page.evaluate(() => window.calls), 1);
  assert.equal(await page.evaluate(() => window.reviews), 0);
  if (count > 5) { await page.getByRole('button', { name: 'Previous mail', exact: true }).click(); await page.getByRole('button', { name: 'Refresh mail priorities' }).click(); await page.waitForFunction(() => document.querySelector('[data-mail-range]')?.textContent.startsWith('Decisions 1–5')); }
});
test('locked review preserves opener and focus until close', async t => {
  const page = await open(t, 25);
  await page.getByRole('button', { name: 'Next mail', exact: true }).click();
  const opener = page.locator('li button').first(); await opener.click();
  for (const name of ['Next mail', 'Previous mail', 'Refresh mail priorities', 'Hide mail priorities']) assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.opener.isConnected), true);
  await page.evaluate(() => { window.render(false); requestAnimationFrame(() => window.opener.focus()); });
  await page.waitForFunction(() => document.activeElement === window.opener);
  assert.equal(await page.evaluate(() => window.calls), 1);
});
for (const end of ['retire', 'unmount', 'refusal']) test(`later page ${end} fences pending refresh`, async t => {
  const page = await open(t, 25); await page.getByRole('button', { name: 'Next mail', exact: true }).click();
  await page.evaluate(end => { window.pending = true; if (end === 'refusal') window.failure = { status: 403 }; }, end);
  await page.getByRole('button', { name: 'Refresh mail priorities' }).click();
  await page.evaluate(end => { if (end === 'retire') dispatchEvent(new Event('doctorcre-session-invalidated')); if (end === 'unmount') window.root.unmount(); window.release(); }, end);
  if (end !== 'unmount') await page.getByText('Sign in to view mail priorities.').waitFor();
  assert.equal(await page.locator('[data-mail-proposal], [data-mail-range]').count(), 0);
});
