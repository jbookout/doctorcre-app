import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { validateLeadWorkspace, validateLeadDetail } from '../js/leads-client.js';

const recording = JSON.parse(await readFile(new URL('./fixtures/research-attention/recordings.json', import.meta.url)));
validateLeadWorkspace(recording);
validateLeadDetail(recording.detail, recording.leads[0].id);
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`research attention projection and lifecycle ${width} ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo' });
    page.setDefaultTimeout(5000);
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    let reads = 0, writes = 0;
    let reject = false;
    let restoring = false;
    await routeLeads(page, { onRead: () => reads++, onWrite: () => writes++, getBoard: async () => {
      if (restoring) await page.evaluate(async () => {
        await window.researchClose;
        if (!window.researchApp.state.identityReady) throw new Error('Expected verified identity before board response');
        document.querySelector('#leadDetail').dispatchEvent(new Event('close'));
      });
      return recording;
    }, getDetail: (row, args) => {
      if (reject) return { ...recording.detail, research: { ...recording.detail.research, evidence: [{ ...recording.detail.research.evidence[0], observed_at: 'not-a-date' }] } };
      const next = structuredClone(recording.detail);
      next.id = row.id;
      if (row.id !== recording.detail.id) next.research.evidence = [];
      if (args.correspondence_cursor) {
        next.correspondence = [{ id: 'older', kind: 'email_in', occurred_at: '2026-09-01T12:00:00Z', summary: 'Older', detail: 'Older' }];
        next.correspondence_page = { total: 3, has_more: false, next_cursor: null };
      }
      validateLeadDetail(next, row.id);
      return next;
    } });
    await page.route('**/leads', async route => {
      const html = await readFile(new URL('../leads.html', import.meta.url), 'utf8');
      const bootstrap = `<script type="module">const board=document.getElementById('leadBoard');board.id='fixtureBoard';const {mountLeadsWorkspace}=await import('/js/leads-workspace-app.js');board.id='leadBoard';window.researchApp=mountLeadsWorkspace();</script>`;
      await route.fulfill({ contentType: 'text/html', body: html.replace('<script type="module" src="/js/leads-workspace-app.js"></script>', bootstrap) });
    });
    await page.goto('http://localhost/leads');
    await page.locator('[data-open]').first().click();
    const panel = page.locator('#sourcedResearch');
    await panel.waitFor();
    assert.equal(await panel.locator('li').count(), 4);
    const attention = panel.getByLabel('Finding attention', { exact: true });
    const ids = () => panel.locator('li').evaluateAll(nodes => nodes.map(n => n.dataset.flagId));
    const full = recording.detail.research.evidence;
    const initialReads = reads;
    for (const [value, predicate] of [['correction', e => e.proposes_correction === true], ['expired', e => e.expired === true], ['nothing', e => e.found === false], ['', () => true]]) {
      await attention.selectOption(value);
      assert.deepEqual(await ids(), full.filter(predicate).map(e => e.flag_id));
      assert.equal(await panel.getByRole('status').innerText(), `${full.filter(predicate).length} of ${full.length} loaded findings`);
    }
    const recordedGuidance = (await panel.locator(':scope > p').allTextContents()).slice(0, 2);
    await attention.selectOption('expired');
    await panel.getByLabel('Finding kind', { exact: true }).selectOption('discrepancy');
    assert.deepEqual(await ids(), []);
    assert.deepEqual((await panel.locator(':scope > p').allTextContents()).slice(0, 2), recordedGuidance, 'zero matches preserve exact server state and next_step');
    assert.ok((await panel.innerText()).includes(recording.detail.research.next_step));
    await attention.selectOption('');
    assert.equal(await panel.getByLabel('Finding kind', { exact: true }).inputValue(), 'discrepancy');
    await panel.getByLabel('Finding kind', { exact: true }).selectOption('');
    await attention.focus(); await attention.press('n'); await attention.press('Tab');
    assert.equal(await attention.inputValue(), 'nothing');
    await page.evaluate(() => window.researchApp.readDetail(window.researchApp.state.detailId, false));
    assert.equal(await attention.inputValue(), 'nothing', 'same lead refresh retains attention');
    assert.equal(reads, initialReads + 1, 'only explicit refresh reads');
    await page.evaluate(() => window.researchApp.refresh());
    assert.equal(await attention.inputValue(), 'nothing', 'successful workspace refresh retains attention');
    await attention.selectOption('');
    const selector = panel.getByLabel('Finding kind', { exact: true });
    await selector.waitFor();
    const kinds = [...new Set(recording.detail.research.evidence.map(e => e.kind).filter(k => k.trim()))];
    assert.deepEqual(await selector.locator('option').allTextContents(), ['All finding kinds', ...kinds]);
    const calls = reads;
    await selector.focus();
    await selector.press(kinds[0][0]);
    await selector.press('Tab');
    const chosen = await selector.inputValue();
    assert.equal(chosen, kinds[0]);
    assert.deepEqual(await panel.locator('li').evaluateAll(nodes => nodes.map(n => n.dataset.flagId)), recording.detail.research.evidence.filter(e => e.kind === chosen).map(e => e.flag_id));
    assert.match(await panel.innerText(), /Needs review/);
    assert.equal(reads, calls); assert.equal(writes, 0);
    await selector.selectOption('');
    const first = panel.locator('li').first();
    assert.equal(await first.locator('time').first().getAttribute('datetime'), '2026-11-06T01:00:00Z');
    assert.match(await first.innerText(), /Observed.*Nov 5, 2026.*7:00.*PM.*CST/);
    assert.match(await first.innerText(), /Expires on.*Feb 29, 2028/);
    assert.match(await panel.locator('li').nth(1).innerText(), /Expiry unrecorded/);
    assert.match(await panel.locator('li').nth(1).innerText(), /Nov 5, 2026.*7:00.*PM/);
    assert.match(await panel.locator('li').nth(2).innerText(), /Feb 29, 2024.*11:00.*PM.*Expiry date unavailable/s);
    assert.match(await panel.locator('li').nth(3).innerText(), /Observed time unavailable.*Expiry date unavailable/s);
    assert.ok((await panel.innerText()).includes(recording.detail.research.next_step), 'server outreach guidance preserved');
    assert.match(await panel.innerText(), /Needs review/);
    assert.match(await panel.innerText(), /Nothing found/);
    assert.match(await panel.innerText(), /Proposed correction/);
    assert.equal(await panel.locator('.research-expiry').innerText(), 'Expired');
    assert.equal(await first.getByRole('link').getAttribute('href'), 'https://example.test/source/0');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await selector.selectOption(kinds[0]);
    await attention.selectOption('nothing');
    const before = await panel.innerText();
    await page.locator('#load-correspondence').click();
    await page.getByText('Older', { exact: true }).first().waitFor();
    assert.equal(await panel.innerText(), before, 'history repaint preserves dates and selected kind');
    assert.equal(await selector.inputValue(), kinds[0]);
    await page.locator('#closeDetail').click();
    await page.locator('[data-open]').nth(1).click();
    await panel.getByText('No sourced findings.', { exact: true }).waitFor();
    assert.equal(await panel.locator('time').count(), 0, 'lead switch clears dates');
    await page.locator('#closeDetail').click();
    reject = true;
    await page.locator('[data-open]').first().click();
    await page.locator('#detailBody [role=alert]').waitFor();
    assert.equal(await panel.count(), 0, 'rejected detail clears dates');
    reject = false;
    await page.locator('#closeDetail').click();
    await page.locator('[data-open]').first().click();
    await panel.waitFor();
    assert.equal(await attention.inputValue(), '', 'different lead resets attention');
    await attention.selectOption('expired');
    await page.evaluate(() => {
      const dialog = document.querySelector('#leadDetail');
      window.researchClose = new Promise(resolve => {
        dialog.addEventListener('close', event => { event.stopImmediatePropagation(); resolve(); }, { capture: true, once: true });
      });
      window.dispatchEvent(new Event('doctorcre-session-invalidated'));
    });
    await panel.waitFor({ state: 'detached' });
    restoring = true;
    await page.evaluate(() => window.researchApp.refresh());
    await panel.waitFor();
    assert.equal(await attention.inputValue(), '', 'authorization retirement resets attention');
    await page.evaluate(() => window.researchApp.dispose());
    assert.equal(await panel.count(), 0, 'disposal clears rendered dates');
  });
}


test('attention fixture replays its real producer with overlapping flags', async () => {
  const { stripTypeScriptTypes } = await import('node:module');
  const source = await readFile(new URL('./fixtures/research-kind-filter/producer.txt', import.meta.url), 'utf8');
  const { researchSummary } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
  const { clock } = JSON.parse(await readFile(new URL('./fixtures/research-kind-filter/provenance.json', import.meta.url)));
  assert.deepEqual(researchSummary(recording.detail.research.evidence, Date.parse(clock)), recording.detail.research);
  assert.ok(recording.detail.research.evidence.some(e => e.proposes_correction && e.expired && !e.found));
  validateLeadDetail(recording.detail, recording.detail.id);
});
test('attention disposal clears rendered dates and ignores a late detail response', async t => {
  const { JSDOM } = await import('jsdom');
  const { mountLeadsWorkspace } = await import('../js/leads-workspace-app.js');
  const dom = new JSDOM(await readFile(new URL('../leads.html', import.meta.url), 'utf8'), { url: 'https://example.test/leads', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let resolveLate;
  let late = false;
  const client = { getActor: async () => 'example-partner', getWorkspace: async () => structuredClone(recording), getLeadDetail: async () => late ? new Promise(resolve => { resolveLate = resolve; }) : structuredClone(recording), getQuietFollowUps: async () => ({ schema_version: 'quiet-follow-ups.v1', cadence: { lead_days: 45, vendor_days: 90 }, proposals: [], sent: false, tasks_created: false }) };
  const app = mountLeadsWorkspace(w.document, client, { mapFactory: async () => ({ update() {}, dispose() {} }) });
  t.after(() => { app.dispose(); w.close(); });
  await app.refresh();
  await app.readDetail(recording.detail.id);
  assert.ok(w.document.querySelector('#sourcedResearch'));
  late = true;
  const pending = app.readDetail(recording.detail.id, false);
  app.dispose();
  assert.equal(w.document.querySelector('#sourcedResearch'), null);
  resolveLate(structuredClone(recording));
  await pending;
  assert.equal(w.document.querySelector('#sourcedResearch'), null);
});

for (const boundary of ['lead change', 'authorization retirement', 'disposal', 'disposal after authorization retirement']) {
  test(`attention ${boundary} resets both selectors and rejects a late read`, async t => {
    const { JSDOM } = await import('jsdom');
    const { mountLeadsWorkspace } = await import('../js/leads-workspace-app.js');
    const dom = new JSDOM(await readFile(new URL('../leads.html', import.meta.url), 'utf8'), { url: 'https://example.test/leads', pretendToBeVisual: true });
    const w = dom.window;
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.open = false; };
    let resolveLate;
    let delayed = false;
    const client = {
      getActor: async () => 'example-partner',
      getWorkspace: async () => structuredClone(recording),
      getLeadDetail: async lead => {
        const response = structuredClone(recording);
        response.detail.id = lead.id;
        validateLeadDetail(response.detail, lead.id);
        if (delayed) return new Promise(resolve => { resolveLate = () => resolve(response); });
        return response;
      },
      getQuietFollowUps: async () => ({ schema_version: 'quiet-follow-ups.v1', cadence: { lead_days: 45, vendor_days: 90 }, proposals: [], sent: false, tasks_created: false }),
    };
    const app = mountLeadsWorkspace(w.document, client, { mapFactory: async () => ({ update() {}, dispose() {} }) });
    t.after(() => { app.dispose(); w.close(); });
    await app.refresh();
    await app.readDetail(recording.detail.id);
    const selector = w.document.querySelector('#researchAttention');
    selector.value = 'expired';
    selector.dispatchEvent(new w.Event('change', { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...w.document.querySelectorAll('#sourcedResearch li')].map(node => node.dataset.flagId), recording.detail.research.evidence.filter(e => e.expired).map(e => e.flag_id));
    const kind = w.document.querySelector('#researchKind');
    kind.value = recording.detail.research.evidence[0].kind;
    kind.dispatchEvent(new w.Event('change', { bubbles: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...w.document.querySelectorAll('#sourcedResearch li')].map(node => node.dataset.flagId), recording.detail.research.evidence.filter(e => e.expired && e.kind === kind.value).map(e => e.flag_id));
    delayed = true;
    const pending = app.readDetail(recording.detail.id, false);
    delayed = false;
    if (boundary === 'lead change') {
      await app.readDetail(recording.leads[1].id);
      assert.equal(w.document.querySelector('#researchAttention').value, '');
      assert.equal(w.document.querySelector('#researchKind').value, '');
      const current = w.document.querySelector('#researchAttention');
      current.value = 'nothing';
      current.dispatchEvent(new w.Event('change', { bubbles: true }));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual([...w.document.querySelectorAll('#sourcedResearch li')].map(node => node.dataset.flagId), recording.detail.research.evidence.filter(e => !e.found).map(e => e.flag_id));
    } else if (boundary === 'authorization retirement') {
      w.dispatchEvent(new w.Event('doctorcre-session-invalidated'));
      assert.equal(w.document.querySelector('#sourcedResearch'), null);
    } else {
      if (boundary === 'disposal after authorization retirement') w.dispatchEvent(new w.Event('doctorcre-session-invalidated'));
      app.dispose();
      assert.equal(w.document.querySelector('#sourcedResearch'), null);
    }
    const visible = w.document.querySelector('#detailBody').innerHTML;
    resolveLate();
    await pending;
    assert.equal(w.document.querySelector('#detailBody').innerHTML, visible, 'late result cannot change the current subject');
    if (boundary === 'authorization retirement') {
      await app.refresh();
      await app.readDetail(recording.detail.id);
      assert.equal(w.document.querySelector('#researchAttention').value, '');
      assert.equal(w.document.querySelector('#researchKind').value, '');
    }
  });
}
