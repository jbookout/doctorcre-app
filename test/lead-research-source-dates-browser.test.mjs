import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { validateLeadWorkspace, validateLeadDetail } from '../js/leads-client.js';

const recording = JSON.parse(await readFile(new URL('./fixtures/lead-research-source-dates/recordings.json', import.meta.url)));
validateLeadWorkspace(recording);
validateLeadDetail(recording.detail, recording.leads[0].id);
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`research dates and lifecycle ${width} ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo' });
    page.setDefaultTimeout(5000);
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    let reject = false;
    let restoring = false;
    await routeLeads(page, { getBoard: async () => {
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
    const before = await panel.innerText();
    await page.locator('#load-correspondence').click();
    await page.getByText('Older', { exact: true }).first().waitFor();
    assert.equal(await panel.innerText(), before, 'history repaint preserves dates');
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
    await page.evaluate(() => window.researchApp.dispose());
    assert.equal(await panel.count(), 0, 'disposal clears rendered dates');
  });
}

test('disposal clears rendered dates and ignores a late detail response', async t => {
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

for (const closeAt of ['before identity', 'after identity', 'after reopen']) {
  test(`research resumes when the suspended dialog close arrives ${closeAt}`, async t => {
    const { JSDOM } = await import('jsdom');
    const { mountLeadsWorkspace } = await import('../js/leads-workspace-app.js');
    const dom = new JSDOM(await readFile(new URL('../leads.html', import.meta.url), 'utf8'), { url: 'https://example.test/leads', pretendToBeVisual: true });
    const w = dom.window;
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.open = false; };
    let releaseBoard;
    let boardStarted;
    const readingBoard = new Promise(resolve => { boardStarted = resolve; });
    let restoring = false;
    const client = {
      getActor: async () => 'example-partner',
      getWorkspace: async () => {
        if (restoring) {
          const pending = new Promise(resolve => { releaseBoard = () => resolve(structuredClone(recording)); });
          boardStarted();
          return pending;
        }
        return structuredClone(recording);
      },
      getLeadDetail: async () => structuredClone(recording),
    };
    const app = mountLeadsWorkspace(w.document, client, { mapFactory: async () => ({ update() {}, dispose() {} }) });
    t.after(() => { app.dispose(); w.close(); });
    await app.refresh();
    await app.readDetail(recording.detail.id);
    assert.ok(w.document.querySelector('#sourcedResearch'));
    const dialog = w.document.querySelector('#leadDetail');
    w.dispatchEvent(new w.Event('doctorcre-session-invalidated'));
    assert.equal(w.document.querySelector('#sourcedResearch'), null);
    if (closeAt === 'before identity') dialog.dispatchEvent(new w.Event('close'));
    restoring = true;
    const pending = app.refresh();
    await readingBoard;
    if (closeAt === 'after identity') dialog.dispatchEvent(new w.Event('close'));
    releaseBoard();
    await pending;
    if (closeAt === 'after reopen') dialog.dispatchEvent(new w.Event('close'));
    assert.equal(dialog.open, true, 'restores the previously open lead');
    assert.equal(w.document.querySelectorAll('#sourcedResearch li').length, 4, 'restores sourced research');
    dialog.close();
    dialog.dispatchEvent(new w.Event('close'));
    restoring = false;
    await app.refresh();
    assert.equal(dialog.open, false, 'an explicit close stays closed');
  });
}
