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
  const result = await build({ stdin: { contents: `export {createRoot} from 'react-dom/client'; export {createElement} from 'react'; export {MailPriorities} from './src/ui/home/mail-priorities'; export {mountMailPriorities} from './src/ui/home/mail-priorities'; export {parseMailPage, startEarlyMailPriorities} from './src/ui/home/mail-priorities-client';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm' });
  bundle = result.outputFiles[0].text;
});
async function open(t, { width = 1280, theme = 'light', response = recordings.ready, failure, pending = false, early = false, beforeMount } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await componentDocument(page, 'http://localhost', { html: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mail panel</title><body><div id="panel"></div>', dispose: p => p.evaluate(() => window.view?.dispose()) });
  await page.route('http://localhost/panel.js', route => route.fulfill({ contentType: 'text/javascript', body: bundle }));
  await page.evaluate(async ({ response, theme, failure, pending, joinItems, early, beforeMount }) => {
    document.documentElement.style.colorScheme = theme;
    const { mountMailPriorities, parseMailPage, startEarlyMailPriorities } = await import('/panel.js');
    window.response = response; window.failure = failure; window.pending = pending; window.calls = 0; window.reviews = [];
    const items = [{ source_type: 'email_proposal', source_id: joinItems[0].proposal_id, item_id: 'existing-home-id', title: 'Existing Home title', review_reference: { kind: 'next_step' } }, { source_type: 'next_action', source_id: joinItems[1].proposal_id, item_id: 'wrong-source', title: 'Must not match' }];
    const read = async signal => {
      window.calls++; window.signal = signal;
      if (window.pending) await new Promise(resolve => window.release = resolve);
      if (window.failure) throw window.failure;
      return parseMailPage(window.response);
    };
    if (early) {
      startEarlyMailPriorities(read);
      if (!pending) await new Promise(resolve => requestAnimationFrame(resolve));
      if (beforeMount === 'retire') dispatchEvent(new Event('doctorcre-session-invalidated'));
      if (beforeMount === 'pagehide') dispatchEvent(new Event('pagehide'));
      if (beforeMount === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }
    }
    window.view = mountMailPriorities(document.getElementById('panel'), { items, review: item => window.reviews.push(item.item_id), read });
  }, { response, theme, failure, pending, early, beforeMount, joinItems: recordings.ready.items });
  await page.waitForFunction(() => window.calls === 1, null, { timeout: 2000 });
  return page;
}
for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`automatic ranked rows, exact join and keyboard review ${width} ${theme}`, async t => {
  const page = await open(t, { width, theme });
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
  await page.getByRole('button', { name: 'Refresh mail priorities' }).click();
  await page.getByRole('button', { name: 'Review Existing Home title' }).waitFor();
  assert.equal(await page.evaluate(() => window.calls), 2);
});
for (const kind of ['empty', 'unavailable', 'malformed', 'network', 'auth']) test(`manual retry and retirement ${kind}`, async t => {
  const page = await open(t, { response: kind === 'malformed' ? { ...recordings.ready, send: true } : recordings[kind] || recordings.ready, failure: kind === 'auth' ? { status: 403 } : kind === 'network' ? { message: 'Network unavailable' } : undefined });
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
  const page = await open(t, { pending });
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
for (const phase of ['collapsed', 'empty', 'unavailable']) for (const end of ['retire', 'dispose']) test(`${phase} ${end} releases the panel`, async t => {
  const page = await open(t, { response: recordings[phase] || recordings.ready });
  if (phase === 'collapsed') await page.getByRole('button', { name: 'Hide mail priorities' }).click();
  else await page.getByText(phase === 'empty' ? 'No recorded pending mail decisions.' : 'Mail priorities unavailable.', { exact: true }).waitFor();
  await page.evaluate(end => { if (end === 'dispose') window.view.dispose(); else dispatchEvent(new Event('doctorcre-session-invalidated')); }, end);
  if (end === 'retire') await page.getByText('Sign in to view mail priorities.').waitFor();
  else await page.waitForFunction(() => document.getElementById('panel').childElementCount === 0);
  assert.equal(await page.getByRole('button').count(), 0);
});

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`published Home transport and layout ${width} ${theme}`, async t => {
  const { buildArtifact } = await import('../scripts/artifact.mjs');
  const { temporaryDirectory } = await import('../scripts/temp-directory.mjs');
  const { ownedFixtureServer: fixtureServer } = await import("./fixture-probe.ts");
  const { join } = await import('node:path');
  const outDir = temporaryDirectory('mail-priority-home-', t);
  await buildArtifact({ root: process.cwd(), outDir });
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  const requests = [];
  let releaseInbox, reachedInbox;
  const inboxRequested = new Promise(resolve => reachedInbox = resolve);
  const inboxAllowed = new Promise(resolve => releaseInbox = resolve);
  await page.route('**/js/ui-inbox.js', async route => { reachedInbox(); await inboxAllowed; await route.continue(); });
  await page.route('**/api/v1/intelligence/mail-needs-partner*', route => {
    requests.push({ method: route.request().method(), url: route.request().url() });
    return route.fulfill({ json: recordings.ready });
  });
  await page.goto(server.origin + '/?mode=fixture', { waitUntil: 'commit' });
  await inboxRequested;
  try {
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/api/v1/intelligence/mail-needs-partner')));
  } finally {
    releaseInbox();
  }
  const earlyReads = requests.length;
  await page.getByText('Only the first 25 ranked decisions are shown.').waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(earlyReads, 1, 'mail starts before the UI entry loads');
  assert.equal(requests.length, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const { mkdir } = await import('node:fs/promises');
  await mkdir('test-artifacts/mail-priorities', { recursive: true });
  await page.screenshot({ path: `test-artifacts/mail-priorities/${width}-${theme}.png`, fullPage: true });
  assert.equal(requests[0].method, 'GET');
  assert.equal(new URL(requests[0].url).search, '?limit=25');
  assert.deepEqual(await page.locator('[data-mail-proposal]').evaluateAll(rows => rows.map(row => row.dataset.mailProposal)), recordings.ready.items.map(row => row.proposal_id));
});

test('collapse cancels pending reads, reopening reads once and rerenders do not read', async t => {
  const page = await open(t, { pending: true });
  await page.getByText('Loading mail priorities…').waitFor();
  await page.getByRole('button', { name: 'Hide mail priorities' }).click();
  assert.equal(await page.evaluate(() => window.signal.aborted), true);
  await page.evaluate(() => { window.pending = false; window.release(); });
  assert.equal(await page.locator('[data-mail-proposal]').count(), 0);
  await page.getByRole('button', { name: 'Show mail priorities' }).click();
  await page.getByRole('button', { name: 'Review Existing Home title' }).waitFor();
  await page.getByRole('button', { name: 'Review Existing Home title' }).click();
  assert.equal(await page.evaluate(() => window.calls), 2);
});
for (const event of ['pagehide', 'hidden']) test(`${event} cancels loading and requires explicit reopen`, async t => {
  const page = await open(t, { pending: true });
  await page.getByText('Loading mail priorities…').waitFor();
  await page.evaluate(event => {
    if (event === 'hidden') {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    } else dispatchEvent(new Event('pagehide'));
    window.pending = false; window.release();
  }, event);
  await page.getByRole('button', { name: 'Show mail priorities' }).waitFor();
  assert.equal(await page.evaluate(() => window.signal.aborted), true);
  assert.equal(await page.locator('[data-mail-proposal]').count(), 0);
  assert.equal(await page.evaluate(() => window.calls), 1);
});

test('parent rerender preserves the automatic read and collapsed choice', async t => {
  const page = await open(t);
  await page.getByText('Only the first 25 ranked decisions are shown.').waitFor();
  await page.evaluate(async () => {
    window.view.dispose();
    const { createRoot, createElement, MailPriorities, parseMailPage } = await import('/panel.js');
    window.root = createRoot(document.getElementById('panel'));
    window.props = { items: [], review() {}, read: async () => { window.calls++; return parseMailPage(window.response); } };
    window.rerender = locked => window.root.render(createElement(MailPriorities, { ...window.props, locked }));
    window.view = { dispose: () => window.root.unmount() };
    window.calls = 0; window.rerender(false);
  });
  await page.getByText('Only the first 25 ranked decisions are shown.').waitFor();
  await page.evaluate(() => window.rerender(true));
  await page.getByRole('button', { name: 'Hide mail priorities' }).click();
  await page.evaluate(() => window.rerender(false));
  await page.getByRole('button', { name: 'Show mail priorities' }).waitFor();
  assert.equal(await page.evaluate(() => window.calls), 1);
  await page.getByRole('button', { name: 'Show mail priorities' }).click();
  await page.getByText('Only the first 25 ranked decisions are shown.').waitFor();
  assert.equal(await page.evaluate(() => window.calls), 2);
});
for (const phase of ['ready', 'empty', 'unavailable']) for (const event of ['collapse', 'pagehide', 'hidden']) test(`${phase} ${event} drops the snapshot`, async t => {
  const page = await open(t, { response: recordings[phase] });
  await page.getByText(phase === 'ready' ? 'Only the first 25 ranked decisions are shown.' : phase === 'empty' ? 'No recorded pending mail decisions.' : 'Mail priorities unavailable.', { exact: true }).waitFor();
  if (event === 'collapse') await page.getByRole('button', { name: 'Hide mail priorities' }).click();
  else await page.evaluate(event => {
    if (event === 'hidden') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }
    else dispatchEvent(new Event('pagehide'));
  }, event);
  await page.getByRole('button', { name: 'Show mail priorities' }).waitFor();
  assert.equal(await page.locator('[data-mail-proposal]').count(), 0);
  assert.equal(await page.evaluate(() => window.calls), 1);
});
test('retired panel can dispose without restarting', async t => {
  const page = await open(t, { failure: { status: 401 } });
  await page.getByText('Sign in to view mail priorities.').waitFor();
  await page.evaluate(() => window.view.dispose());
  await page.waitForFunction(() => document.getElementById('panel').childElementCount === 0);
  assert.equal(await page.evaluate(() => window.calls), 1);
});

for (const pending of [false, true]) test(`early ${pending ? 'in-flight' : 'settled'} read is adopted once`, async t => {
  const page = await open(t, { early: true, pending });
  if (pending) await page.evaluate(() => window.release());
  await page.getByText('Only the first 25 ranked decisions are shown.').waitFor();
  assert.equal(await page.evaluate(() => window.calls), 1);
});
for (const beforeMount of ['pagehide', 'hidden', 'retire']) for (const pending of [false, true]) test(`early ${pending ? 'in-flight' : 'settled'} ${beforeMount} never paints`, async t => {
  const page = await open(t, { early: true, pending, beforeMount });
  await page.evaluate(() => window.release?.());
  await page.getByText(beforeMount === 'retire' ? 'Sign in to view mail priorities.' : 'Show mail priorities', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-mail-proposal]').count(), 0);
  assert.equal(await page.evaluate(() => window.calls), 1);
  assert.equal(await page.evaluate(() => window.signal.aborted), true);
});
for (const response of ['empty', 'unavailable']) test(`early settled ${response} is adopted once`, async t => {
  const page = await open(t, { early: true, response: recordings[response] });
  await page.getByText(response === 'empty' ? 'No recorded pending mail decisions.' : 'Mail priorities unavailable.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.calls), 1);
});

for (const end of ['collapse', 'retire', 'dispose', 'pagehide']) test(`adopted early request ${end} fences late completion`, async t => {
  const page = await open(t, { early: true, pending: true });
  await page.getByText('Loading mail priorities…').waitFor();
  if (end === 'collapse') await page.getByRole('button', { name: 'Hide mail priorities' }).click();
  else await page.evaluate(end => { if (end === 'dispose') window.view.dispose(); else dispatchEvent(new Event(end === 'retire' ? 'doctorcre-session-invalidated' : 'pagehide')); }, end);
  await page.evaluate(() => window.release());
  if (end === 'dispose') await page.waitForFunction(() => document.getElementById('panel').childElementCount === 0);
  else await page.getByText(end === 'retire' ? 'Sign in to view mail priorities.' : 'Show mail priorities', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-mail-proposal]').count(), 0);
  assert.equal(await page.evaluate(() => window.signal.aborted), true);
  assert.equal(await page.evaluate(() => window.calls), 1);
});

test('early settled authorization refusal retires on mount', async t => {
  const page = await open(t, { early: true, failure: { status: 403 } });
  await page.getByText('Sign in to view mail priorities.').waitFor();
  assert.equal(await page.getByRole('button').count(), 0);
  assert.equal(await page.evaluate(() => window.calls), 1);
});
test('pre-mount collapse reopens with a fresh read once', async t => {
  const page = await open(t, { early: true, pending: true, beforeMount: 'pagehide' });
  await page.getByRole('button', { name: 'Show mail priorities' }).waitFor();
  await page.evaluate(() => { window.pending = false; window.release(); });
  await page.getByRole('button', { name: 'Show mail priorities' }).click();
  await page.getByText('Only the first 25 ranked decisions are shown.').waitFor();
  assert.equal(await page.evaluate(() => window.calls), 2);
});

test('late starter cannot duplicate the mounted island read', async t => {
  const page = await open(t, { pending: true });
  await page.evaluate(async () => {
    const { startEarlyMailPriorities, parseMailPage } = await import('/panel.js');
    startEarlyMailPriorities(async () => { window.calls++; return parseMailPage(window.response); });
    window.release();
  });
  await page.getByText('Only the first 25 ranked decisions are shown.').waitFor();
  assert.equal(await page.evaluate(() => window.calls), 1);
});
