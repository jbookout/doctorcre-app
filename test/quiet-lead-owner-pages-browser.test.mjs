import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { validateQuietFollowUps, validateLeadWorkspace, validateLeadDetail } from '../js/leads-client.js';

const recording = JSON.parse(await readFile(new URL('./fixtures/quiet-lead-owner-pages/recordings.json', import.meta.url)));
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`quiet lead owner pages ${width} ${theme}`, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  await routeLeads(page);
  let snapshot = structuredClone(recording), reads = 0, denied = false;
  await page.route('**/mcp', async (route, request) => {
    const params = request.postDataJSON()?.params;
    if (params?.name !== 'quiet-follow-ups') return route.fallback();
    reads++;
    return denied ? route.fulfill({ status: 403, json: { error: 'forbidden' } }) : route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(snapshot) }] } } });
  });
  await page.goto('http://localhost/leads');
  const section = page.locator('#quietFollowUps');
  const owner = section.getByRole('combobox', { name: 'Quiet lead owner' });
  await owner.waitFor();
  const leads = recording.proposals.filter(row => row.subject_type === 'lead');
  assert.equal(await section.locator('li').count(), 10);
  assert.equal(await owner.locator('option').count(), new Set(leads.map(row => row.owner).filter(Boolean)).size + 2);
  const initialReads = reads;
  await owner.focus(); await page.keyboard.press('j'); await page.keyboard.press('Enter');
  await owner.selectOption('owner:joe');
  const joe = leads.filter(row => row.owner === 'joe');
  await section.getByText(`Showing 1–10 of ${joe.length} matching loaded leads (${leads.length} loaded).`, { exact: true }).waitFor();
  await section.getByRole('button', { name: 'Next leads', exact: true }).focus(); await page.keyboard.press('Enter');
  await section.getByText(`Showing 11–${Math.min(20, joe.length)} of ${joe.length} matching loaded leads (${leads.length} loaded).`, { exact: true }).waitFor();
  assert.equal(await section.locator('li').count(), Math.min(10, joe.length - 10));
  await owner.selectOption('unrecorded');
  assert.equal(await section.locator('li').count(), leads.filter(row => row.owner == null).length);
  await owner.selectOption('owner:JOE');
  assert.equal(await section.locator('li').count(), leads.filter(row => row.owner === 'JOE').length);
  assert.equal(await owner.getByRole('option', { name: 'Recorded owner · JOE', exact: true }).count(), 1);
  await owner.selectOption('owner:dell');
  assert.equal(await section.locator('li').count(), leads.filter(row => row.owner === 'dell').length);
  await owner.selectOption('all');
  assert.equal(await section.locator('a').first().getAttribute('href'), `/leads?lead=${encodeURIComponent(leads[0].ref)}`);
  assert.match(await section.innerText(), /No contact recorded|Last contact/);
  assert.equal(reads, initialReads, 'local controls make no RPC');
  assert.equal(await section.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: `/tmp/WR647-S19-J1-${width}-${theme}.png` });
  await owner.selectOption('owner:joe');
  await page.locator('#refreshBoard').click();
  await owner.waitFor(); assert.equal(await owner.inputValue(), 'owner:joe');
  snapshot = { ...recording, proposals: recording.proposals.filter(row => row.owner !== 'joe') };
  await page.locator('#refreshBoard').click();
  await section.getByText('The selected owner is no longer in this snapshot. Showing all owners.').waitFor();
  assert.equal(await owner.inputValue(), 'all');
  assert.equal(await section.getByText('Synthetic vendor excluded', { exact: true }).count(), 0);
  snapshot = { ...recording, proposals: [{ ...leads[0], owner: 4 }] };
  await page.locator('#refreshBoard').click(); await section.getByRole('alert').waitFor();
  assert.equal(await owner.count(), 0);
  const omitted = { ...leads[0] }; delete omitted.owner;
  snapshot = { ...recording, proposals: [omitted] };
  await page.locator('#refreshBoard').click(); await owner.waitFor();
  await owner.selectOption('unrecorded'); assert.equal(await section.locator('li').count(), 1);
  snapshot = { ...recording, proposals: [{ ...leads[0], owner: 'joe' }] };
  await page.locator('#refreshBoard').click(); await owner.waitFor();
  const beforeEmptyFilter = reads;
  await owner.selectOption('unrecorded');
  await section.getByText('No quiet leads match this owner.').waitFor();
  assert.equal(await section.locator('li').count(), 0);
  assert.equal(reads, beforeEmptyFilter);
  snapshot = { ...recording, proposals: [] };
  await page.locator('#refreshBoard').click(); await section.getByText('No quiet leads.').waitFor();
  denied = true;
  await page.locator('#refreshBoard').click();
  await owner.waitFor({ state: 'detached' });
  assert.equal(await section.locator('a').count(), 0);
});

test('malformed owners are unavailable, omitted owners remain unrecorded', () => {
  for (const owner of [2, {}, [], false, '', '  ']) assert.throws(() => validateQuietFollowUps({ ...recording, proposals: [{ ...recording.proposals[0], owner }] }));
  const row = { ...recording.proposals[0] }; delete row.owner;
  validateQuietFollowUps({ ...recording, proposals: [row] });
});

test('retirement, suspension, stale board completion, refusal retry and disposal', async t => {
  const { JSDOM } = await import('jsdom');
  const { mountLeadsWorkspace } = await import('../js/leads-workspace-app.js');
  const { workspace } = await import('./leads-workspace-fixture.mjs');
  const dom = new JSDOM(await readFile(new URL('../leads.html', import.meta.url), 'utf8'), { url: 'http://localhost/leads', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const pending = [];
  const client = { getActor: async () => 'joe', getWorkspace: async () => workspace(), getQuietFollowUps: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
  const app = mountLeadsWorkspace(w.document, client, { mapFactory: async () => ({ update() {}, dispose() {} }) });
  t.after(() => { app.dispose(); w.close(); });
  const section = w.document.querySelector('#quietFollowUps');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await app.refresh();
  pending.at(-1).resolve(recording); await settle();
  assert.equal(section.querySelectorAll('li').length, 10);
  pending[0].resolve({ ...recording, proposals: [] }); await settle();
  assert.equal(section.querySelectorAll('li').length, 10, 'superseded board completion ignored');
  await app.refresh(); pending.at(-1).reject({ code: 'network_error' }); await settle();
  assert.match(section.textContent, /could not reach/); assert.equal(section.querySelector('select'), null);
  await app.refresh(); pending.at(-1).resolve(recording); await settle();
  assert.equal(section.querySelectorAll('li').length, 10, 'explicit retry');
  await app.refresh();
  w.dispatchEvent(new w.Event('doctorcre-session-invalidated'));
  pending.at(-1).resolve(recording); await settle();
  assert.equal(section.querySelector('select'), null, 'auth retirement ignores late completion');
  await app.refresh(); pending.at(-1).resolve(recording); await settle();
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, value: 'hidden' });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  assert.equal(section.querySelector('select'), null, 'suspension clears snapshot');
  await app.refresh();
  app.dispose(); pending.at(-1).resolve(recording); await settle();
  assert.equal(section.querySelector('select'), null, 'disposal ignores completion');
  await app.refresh(); await settle();
  assert.equal(section.querySelector('select'), null, 'disposed page cannot revive');
});


test('registered producer recording retains its pinned source and app parser contract', async () => {
  const root = new URL('./fixtures/quiet-lead-owner-pages/', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root)));
  assert.equal(createHash('sha256').update(await readFile(new URL('producer.txt', root))).digest('hex'), provenance.sha256);
  assert.equal(provenance.revision, 'd2ca440d318e75f85f49c60b83700979cac57d51');
  validateQuietFollowUps(recording);
  assert.ok(recording.proposals.some(row => row.subject_type === 'vendor'));
  assert.equal(recording.sent, false);
  assert.equal(recording.tasks_created, false);
});

test('both workspace islands clear on hidden, reject delayed reads, resume and retire on pagehide then dispose', async t => {
  const research = JSON.parse(await readFile(new URL('./fixtures/research-kind-filter/recordings.json', import.meta.url)));
  validateLeadWorkspace(research);
  validateLeadDetail(research.detail, research.detail.id);
  validateQuietFollowUps(recording);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await routeLeads(page);
  await page.route('**/leads', async route => {
    const html = await readFile(new URL('../leads.html', import.meta.url), 'utf8');
    const bootstrap = `<script type="module">
      const board = document.getElementById('leadBoard');
      board.id = 'fixtureBoard';
      const { mountLeadsWorkspace } = await import('/js/leads-workspace-app.js');
      board.id = 'leadBoard';
      window.fixture = { research: ${JSON.stringify(research)}, quiet: ${JSON.stringify(recording)}, held: false, pending: [], reads: { board: 0, detail: 0, quiet: 0 } };
      const read = kind => {
        fixture.reads[kind]++;
        const value = structuredClone(kind === 'quiet' ? fixture.quiet : fixture.research);
        return fixture.held ? new Promise(resolve => fixture.pending.push({ kind, resolve: () => resolve(value) })) : Promise.resolve(value);
      };
      window.app = mountLeadsWorkspace(document, {
        getActor: async () => 'example-partner',
        getWorkspace: () => read('board'),
        getLeadDetail: () => read('detail'),
        getQuietFollowUps: () => read('quiet'),
      }, { mapFactory: async () => ({ update() {}, dispose() {} }) });
    </script>`;
    await route.fulfill({ contentType: 'text/html', body: html.replace('<script type="module" src="/js/leads-workspace-app.js"></script>', bootstrap) });
  });
  await page.goto('http://localhost/leads');
  const counts = () => page.evaluate(() => ({
    quiet: document.querySelectorAll('#quietFollowUps li').length,
    research: document.querySelectorAll('#sourcedResearch li').length,
  }));
  const mounted = async () => {
    await page.waitForFunction(() => document.querySelectorAll('#quietFollowUps li').length === 10 && document.querySelectorAll('#sourcedResearch li').length === 4);
    assert.deepEqual(await counts(), { quiet: 10, research: 4 });
  };
  const holdReads = async () => {
    await page.evaluate(() => {
      fixture.held = true;
      window.lateDetail = app.readDetail(fixture.research.detail.id, false);
      window.lateBoard = app.refresh();
    });
    await page.waitForFunction(() => ['board', 'detail', 'quiet'].every(kind => fixture.pending.some(read => read.kind === kind)));
  };
  const completeReads = async () => {
    await page.evaluate(async () => {
      for (const pending of fixture.pending.splice(0)) pending.resolve();
      await Promise.all([lateDetail, lateBoard]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  };
  const hide = () => page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    return { quiet: document.querySelectorAll('#quietFollowUps li').length, research: document.querySelectorAll('#sourcedResearch li').length };
  });
  const resume = () => page.evaluate(async () => {
    fixture.held = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await app.refresh();
    await app.readDetail(fixture.research.detail.id);
  });
  await page.waitForFunction(() => window.app?.state.identityReady);
  await page.evaluate(() => app.readDetail(fixture.research.detail.id));
  await mounted();
  assert.deepEqual(await hide(), { quiet: 0, research: 0 }, 'hidden clears both populated islands immediately');
  await resume();
  await mounted();
  await holdReads();
  const beforeResume = await page.evaluate(() => ({ ...fixture.reads }));
  assert.deepEqual(await hide(), { quiet: 0, research: 0 }, 'hidden clears both islands during reads');
  await completeReads();
  assert.deepEqual(await counts(), { quiet: 0, research: 0 }, 'hidden rejects all delayed completions');
  await resume();
  await mounted();
  const afterResume = await page.evaluate(() => fixture.reads);
  for (const kind of ['board', 'detail', 'quiet']) assert.ok(afterResume[kind] > beforeResume[kind], `visible return reads fresh ${kind}`);
  await holdReads();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    app.dispose();
    app.dispose();
  });
  assert.deepEqual(await counts(), { quiet: 0, research: 0 }, 'pagehide then repeated dispose clears both islands');
  await completeReads();
  assert.deepEqual(await counts(), { quiet: 0, research: 0 }, 'disposed islands reject all delayed completions');
  await page.evaluate(async () => {
    fixture.held = false;
    await app.refresh();
    await app.readDetail(fixture.research.detail.id);
  });
  assert.deepEqual(await counts(), { quiet: 0, research: 0 }, 'explicit reads cannot revive disposed islands');
});
