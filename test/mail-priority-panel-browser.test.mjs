import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

test('production boundary accepts registered recordings and refuses malformed data', async () => {
  const { outputFiles } = await build({ entryPoints: ['src/ui/home/mail-priorities-client.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { parseMailPage } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));
  const recordings = JSON.parse(await readFile('test/fixtures/mail-priority-panel/recordings.json'));
  for (const page of Object.values(recordings)) assert.equal(parseMailPage(page).state, page.state);
  for (const mutate of [p => p.send = true, p => p.items[0].decision_date = '2026-02-31', p => p.items[0].reason_codes = ['probable'], p => p.coverage.as_of_day = null]) {
    const page = structuredClone(recordings.ready); mutate(page); assert.throws(() => parseMailPage(page));
  }
});

import { before } from 'node:test';
import { chromium, componentDocument } from './browser-harness.mjs';
import { createHash } from 'node:crypto';
let bundle;
const recordings = JSON.parse(await readFile('test/fixtures/mail-priority-panel/recordings.json'));
before(async () => {
  const result = await build({ stdin: { contents: `export {mountMailPriorities} from './src/ui/home/mail-priorities'; export {parseMailPage} from './src/ui/home/mail-priorities-client';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm' });
  bundle = result.outputFiles[0].text;
});
async function open(t, { width = 1280, theme = 'light' } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await componentDocument(page, 'http://localhost', { html: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mail panel</title><body><div id="panel"></div>', dispose: p => p.evaluate(() => window.view?.dispose()) });
  await page.route('http://localhost/panel.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.evaluate(async ({ response, theme }) => {
    document.documentElement.style.colorScheme = theme;
    const { mountMailPriorities, parseMailPage } = await import('/panel.js');
    window.response = response; window.calls = 0; window.reviews = [];
    const items = [{ source_type: 'email_proposal', source_id: response.items[0].proposal_id, item_id: 'existing-home-id', title: 'Existing Home title', review_reference: { kind: 'next_step' } }, { source_type: 'next_action', source_id: response.items[1].proposal_id, item_id: 'wrong-source', title: 'Must not match' }];
    window.view = mountMailPriorities(document.getElementById('panel'), { items, review: item => window.reviews.push(item.item_id), read: async signal => {
      window.calls++; window.signal = signal;
      if (window.pending) await new Promise(resolve => window.release = resolve);
      if (window.failure) throw window.failure;
      return parseMailPage(window.response);
    } });
  }, { response: recordings.ready, theme });
  await page.getByRole('button', { name: 'Show mail priorities' }).waitFor();
  return page;
}
for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`opt-in ranked rows, exact join and keyboard review ${width} ${theme}`, async t => {
  const page = await open(t, { width, theme });
  assert.equal(await page.evaluate(() => window.calls), 0);
  await page.getByRole('button', { name: 'Show mail priorities' }).focus(); await page.keyboard.press('Enter');
  await page.getByText('Only the first 25 ranked decisions are shown.').waitFor();
  assert.deepEqual(await page.locator('[data-mail-proposal]').evaluateAll(nodes => nodes.map(n => n.dataset.mailProposal)), recordings.ready.items.map(row => row.proposal_id));
  const text = await page.getByRole('region', { name: 'Mail priorities' }).textContent();
  assert.match(text, /Mailbox joe.*Recorded inbound pending proposals.*As of 2026-11-06.*Recorded next date in UTC/);
  assert.match(text, /Recorded overdue.*2026-10-01/); assert.match(text, /Recorded upcoming.*2026-12-01/); assert.match(text, /Decision date unknown/); assert.match(text, /Source time unknown/);
  assert.doesNotMatch(text, /probability|Must not match/);
  assert.equal(await page.getByRole('link', { name: 'Review in inbox' }).first().getAttribute('href'), '/inbox');
  await page.getByRole('button', { name: 'Review Existing Home title' }).focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.reviews), ['existing-home-id']);
  assert.equal(await page.evaluate(() => window.calls), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
for (const kind of ['empty', 'unavailable', 'malformed', 'network', 'auth']) test(`manual retry and retirement ${kind}`, async t => {
  const page = await open(t);
  await page.evaluate(({ kind, recordings }) => {
    if (kind === 'empty' || kind === 'unavailable') window.response = recordings[kind];
    if (kind === 'malformed') window.response = { ...recordings.ready, send: true };
    if (kind === 'network') window.failure = Error('Synthetic network failure');
    if (kind === 'auth') window.failure = { status: 403 };
  }, { kind, recordings });
  await page.getByRole('button', { name: 'Show mail priorities' }).click();
  await page.getByText(kind === 'empty' ? 'No recorded pending mail decisions.' : kind === 'auth' ? 'Sign in to view mail priorities.' : 'Mail priorities unavailable.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-mail-proposal]').count(), 0);
  assert.equal(await page.evaluate(() => window.calls), 1);
  if (kind === 'auth') { assert.equal(await page.getByRole('button').count(), 0); return; }
  await page.evaluate(response => { window.response = response; window.failure = undefined; }, recordings.ready);
  await page.getByRole('button', { name: kind === 'empty' ? 'Refresh mail priorities' : 'Retry mail priorities' }).click();
  await page.getByRole('button', { name: 'Review Existing Home title' }).waitFor();
  assert.equal(await page.evaluate(() => window.calls), 2);
});
for (const pending of [false, true]) for (const end of ['retire', 'dispose']) test(`${pending ? 'loading' : 'ready'} ${end} fences late completion`, async t => {
  const page = await open(t);
  await page.evaluate(pending => window.pending = pending, pending);
  await page.getByRole('button', { name: 'Show mail priorities' }).click();
  await page.getByText(pending ? 'Loading mail priorities…' : 'Only the first 25 ranked decisions are shown.').waitFor();
  await page.evaluate(end => { if (end === 'dispose') window.view.dispose(); else dispatchEvent(new Event('doctorcre-session-invalidated')); window.release?.(); }, end);
  if (end === 'dispose') await page.waitForFunction(() => document.getElementById('panel').childElementCount === 0);
  else await page.getByText('Sign in to view mail priorities.').waitFor();
  assert.equal(await page.locator('[data-mail-proposal]').count(), 0);
  if (pending) assert.equal(await page.evaluate(() => window.signal.aborted), true);
});
test('pinned producer replay and hash provenance are self-contained', async () => {
  const bytes = await readFile('test/fixtures/mail-priority-panel/producer.txt');
  const provenance = JSON.parse(await readFile('test/fixtures/mail-priority-panel/provenance.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.producer_sha256);
  const producer = await import('data:text/javascript;base64,' + bytes.toString('base64'));
  for (const response of Object.values(recordings)) producer.parseMailNeedsPartnerResponse(response);
  const empty = await producer.family.createTools()['read-mail-needs-partner'].handler({ query: async () => ({ rows: [] }) }, { id: '11111111-1111-4111-8111-111111111111', slug: 'joe', human: true }, { limit: 25 }, new Date('2026-11-06T12:00:00Z'));
  assert.deepEqual(empty, recordings.empty);
});
for (const phase of ['idle', 'empty', 'unavailable']) for (const end of ['retire', 'dispose']) test(`${phase} ${end} releases the panel`, async t => {
  const page = await open(t);
  if (phase !== 'idle') {
    await page.evaluate(response => window.response = response, recordings[phase]);
    await page.getByRole('button', { name: 'Show mail priorities' }).click();
    await page.getByText(phase === 'empty' ? 'No recorded pending mail decisions.' : 'Mail priorities unavailable.', { exact: true }).waitFor();
  }
  await page.evaluate(end => { if (end === 'dispose') window.view.dispose(); else dispatchEvent(new Event('doctorcre-session-invalidated')); }, end);
  if (end === 'retire') await page.getByText('Sign in to view mail priorities.').waitFor();
  else await page.waitForFunction(() => document.getElementById('panel').childElementCount === 0);
  assert.equal(await page.getByRole('button').count(), 0);
});
