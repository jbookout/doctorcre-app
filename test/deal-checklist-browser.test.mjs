import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium, waitForAsync } from './browser-harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'out/test-artifacts/deal-checklist');
const focusEvidence = join(root, '.github/pr-evidence/WR39.S1.J15');
let outDir, server, browser, origin;
before(async () => {
  outDir = await temporaryDirectory('deal-checklist-');
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  ({ server } = await createQaServer({ buildRoot: join(outDir, 'site') }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  await mkdir(evidence, { recursive: true });
  await mkdir(focusEvidence, { recursive: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

async function refreshChecklist(page, trigger, visible) {
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    window.checklistPreviousDetail = state.panelDetail;
  });
  await trigger();
  await waitForAsync(page, async () => {
    const { state } = await import('/js/pipeline.js');
    return state.panelDetail !== window.checklistPreviousDetail;
  });
  await page.waitForFunction(visible => !!document.querySelector('.deal-checklist') === visible, visible);
}

test('Checklist refresh waits for a held detail read even when checklist visibility is unchanged', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'held-checklist-refresh', viewer: 'joe', reset: true } });
  await page.goto(`${origin}/deals?mode=live`);
  await page.locator('.card-open').first().click();
  await page.locator('.deal-opening-snapshot').waitFor();
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const get = state.client.getDeal.bind(state.client);
    window.heldChecklistReads = 0;
    state.client.getDeal = async (...args) => {
      window.heldChecklistReads++;
      await new Promise(resolve => { window.releaseChecklistRead = resolve; });
      return get(...args);
    };
  });
  const visible = await page.locator('.deal-checklist').count() > 0;
  let settled = false;
  const refresh = refreshChecklist(page, () => page.locator('.deal-freshness [data-refresh-detail]').click(), visible)
    .then(() => { settled = true; });
  try {
    await page.waitForFunction(() => !!window.releaseChecklistRead);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(settled, false, 'refresh remains pending until the held detail read finishes');
  } finally {
    await page.evaluate(() => window.releaseChecklistRead());
    await refresh;
  }
  assert.equal(await page.evaluate(() => window.heldChecklistReads), 1, 'refresh uses exactly one detail read');
});

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`signed-in checklist preserves drafts through unavailable and recovered refreshes at ${width}px in ${theme}`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 960 }, timezoneId: 'America/Chicago', reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `checklist-${width}-${theme}`, viewer: 'joe', reset: true } })).status(), 200);
  const response = await page.request.post(`${origin}/mcp`, { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deal-room-board', arguments: {} } } });
  const envelope = await response.json();
  assert.equal(JSON.parse(envelope.result.content[0].text).actor, 'joe');
  await page.goto(`${origin}/deals?mode=live`);
  await page.locator('.kanban-card').first().waitFor();
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js'); const get = state.client.getDeal;
    window.checklistMode = 'malformed';
    window.checklistReads = 0;
    state.client.getDeal = async (...args) => {
      window.checklistReads++;
      const detail = await get(...args);
      const complete = window.checklistMode === 'complete';
      const received = window.checklistMode === 'received';
      const review = { id: 'review', label: window.checklistMode === 'long' ? 'Synthetic attorney requirement with a long recorded description '.repeat(8) : 'Demo attorney review', status: complete ? 'complete' : received ? 'received' : 'due', due_on: '2026-10-20',
        evidence_ref: received ? 'attachment:synthetic-document' : 'Demo contract clause 3',
        request: { status: received ? 'fulfilled' : 'open', satisfied: false }, source: { document: 'deal-room-kit', version: 1 } };
      const malformed = {
        'array-status': { status: ['complete'] },
        'object-status': { status: { toString: null } },
        'object-evidence': { evidence_ref: { toString: null } },
        'object-version': { source: { document: 'kit', version: { toString: null } } },
        'object-document': { source: { document: { toString: null }, request: 'valid' } },
      }[window.checklistMode];
      if (malformed) Object.assign(review, JSON.parse(JSON.stringify(malformed)));
      const lease = { id: 'lease', label: 'Executed lease', status: 'not_recorded', evidence_ref: null, source: { document: 'deal-room-kit', version: 1 } };
      return { ...detail, checklist: window.checklistMode === 'absent' ? null : {
        schema_version: 'deal-checklist.v1', template_state: ['unavailable', 'source_changed', 'deal_type_unknown'].includes(window.checklistMode) ? window.checklistMode : 'current',
        due_items: complete || received || ['empty', 'unavailable'].includes(window.checklistMode) ? [] : [review],
        phases: window.checklistMode === 'malformed' ? null : ['empty', 'unavailable'].includes(window.checklistMode) ? [] : [{ id: 'legal', label: 'Legal / lease', items: complete ? [lease, review] : [review, lease] }],
      } };
    };
  });
  await page.locator('.card-open').first().click();
  const checklist = page.locator('.deal-checklist');
  const summary = checklist.locator(':scope > summary');
  await checklist.getByText('Checklist unavailable.', { exact: true }).waitFor();
  assert.equal(await page.locator('#detailUpdateForm').count(), 1);
  assert.equal(await page.locator('.deal-opening-snapshot').count(), 1);
  await checklist.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, `${width}-${theme}-malformed.png`), animations: 'disabled' });
  await page.evaluate(() => { window.checklistMode = 'due'; });
  await checklist.getByRole('button', { name: 'Refresh deal', exact: true }).click();
  await summary.waitFor();
  assert.equal(await summary.evaluate(element => document.activeElement === element), true);
  assert.match(await summary.textContent(), /Demo attorney review/);
  assert.equal(await checklist.evaluate(element => element.open), false);
  const dueBox = await summary.boundingBox();
  const panelBox = await page.locator('#recordPanel').boundingBox();
  assert.ok(dueBox.y >= panelBox.y && dueBox.y + dueBox.height <= panelBox.y + panelBox.height, 'the next due item is visible when the deal opens');
  await checklist.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, `${width}-${theme}-due.png`), animations: 'disabled' });
  await summary.focus();
  await page.keyboard.press('Enter');
  const review = checklist.locator('[data-checklist-item="review"] details');
  await review.locator('summary').click();
  await page.getByLabel('Update', { exact: true }).fill('Demo unsaved update');
  await page.evaluate(() => { window.checklistMode = 'received'; });
  await page.locator('[data-refresh-detail]').click();
  await checklist.getByText('Received', { exact: true }).waitFor();
  assert.equal(await checklist.locator('[data-checklist-item="review"]').getAttribute('data-state'), 'received');
  assert.doesNotMatch(await summary.textContent(), /due|Demo attorney review/);
  assert.equal(await checklist.getByText('Recorded complete', { exact: true }).count(), 0);
  assert.match(await review.textContent(), /attachment:synthetic-document/);
  assert.equal(await review.evaluate(element => element.open), true);
  assert.equal(await page.getByLabel('Update', { exact: true }).inputValue(), 'Demo unsaved update');
  assert.equal(await page.locator('#recordPanel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await checklist.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, `${width}-${theme}-received.png`), animations: 'disabled' });
  await page.evaluate(() => { window.checklistMode = 'complete'; });
  await page.locator('[data-refresh-detail]').click();
  await page.getByText('Recorded complete', { exact: true }).waitFor();
  assert.equal(await checklist.evaluate(element => element.open), true);
  assert.equal(await review.evaluate(element => element.open), true, 'refresh preserves the opened item even after reordering');
  assert.equal(await checklist.locator('[data-checklist-item="lease"] details').evaluate(element => element.open), false, 'an unopened item stays closed');
  assert.equal(await page.getByLabel('Update', { exact: true }).inputValue(), 'Demo unsaved update');
  assert.equal(await page.locator('#recordPanel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  await checklist.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, `${width}-${theme}-refreshed.png`), animations: 'disabled' });
  for (const mode of ['array-status', 'object-status', 'object-evidence', 'object-version', 'object-document', 'malformed']) {
    await summary.focus();
    await page.evaluate(mode => { window.checklistMode = mode; }, mode);
    await page.locator('.deal-freshness [data-refresh-detail]').click();
    const retry = checklist.getByRole('button', { name: 'Refresh deal', exact: true });
    await checklist.getByText('Checklist unavailable.', { exact: true }).waitFor();
    assert.equal(await page.locator('.deal-freshness [data-refresh-detail]').evaluate(element => document.activeElement === element), true, `${mode} retains refresh focus`);
    assert.equal(await page.locator('#detailUpdateForm').count(), 1, `${mode} retains Overview`);
    assert.equal(await page.locator('.deal-opening-snapshot').count(), 1);
    assert.equal(await page.getByLabel('Update', { exact: true }).inputValue(), 'Demo unsaved update');
    assert.equal(await checklist.locator('[data-checklist-item]').count(), 0);
    assert.doesNotMatch(await checklist.textContent(), /Recorded complete/);
    await page.evaluate(() => { window.checklistMode = 'due'; });
    await retry.click();
    await summary.waitFor();
    assert.equal(await summary.evaluate(element => document.activeElement === element), true);
  }
  for (const mode of ['empty', 'due', 'absent', 'empty', 'due', 'unavailable', 'empty', 'unavailable', 'complete', 'source_changed', 'deal_type_unknown', 'long']) {
    const reads = await page.evaluate(() => window.checklistReads);
    await page.evaluate(mode => { window.checklistMode = mode; }, mode);
    const recovering = await checklist.getByText('Requirements could not be read.', { exact: true }).count() > 0;
    await refreshChecklist(page, async () => {
      if (recovering) {
        const retry = checklist.getByRole('button', { name: 'Refresh deal', exact: true });
        await retry.focus();
        await page.keyboard.press(width === 390 ? 'Space' : 'Enter');
      }
      else await page.locator('.deal-freshness [data-refresh-detail]').click();
    }, !['empty', 'absent'].includes(mode));
    if (mode === 'empty' && recovering) {
      const refresh = page.locator('.deal-freshness [data-refresh-detail]');
      assert.equal(await refresh.evaluate(element => document.activeElement === element), true, 'empty recovery returns focus to the header refresh control');
      const refreshBox = await refresh.boundingBox();
      assert.ok(refreshBox.y >= 0 && refreshBox.y + refreshBox.height <= 960, 'the focused refresh control is visible after recovery');
      await page.screenshot({ path: join(focusEvidence, `${width}-${theme}-empty-recovery.png`), animations: 'disabled' });
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('#recordPanel').evaluate(element => element.contains(document.activeElement) && document.activeElement.matches('button, input, select, textarea, summary, a[href]')), true, 'Tab continues to a deal control after recovery');
    }
    if (mode === 'unavailable') {
      await checklist.getByText(/Requirements could not be read/).waitFor();
      assert.match(await checklist.textContent(), /Requirements could not be read.*Refresh deal/);
      assert.equal(await checklist.locator('[data-checklist-item]').count(), 0);
      assert.doesNotMatch(await checklist.textContent(), /0 due|Recorded complete|attachment:|Demo contract clause 3/);
      await checklist.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `${width}-${theme}-unavailable.png`), animations: 'disabled' });
    }
    if (mode === 'complete') {
      await checklist.locator('[data-checklist-item="review"][data-state="complete"]').waitFor({ state: 'attached' });
      assert.equal(await summary.evaluate(element => document.activeElement === element), true, 'recovery returns focus to the checklist summary');
      if (!await checklist.evaluate(element => element.open)) {
        await summary.focus();
        await page.keyboard.press('Enter');
      }
      await checklist.getByText('Recorded complete', { exact: true }).waitFor();
      await review.locator('summary').focus();
      await page.keyboard.press('Enter');
      assert.match(await review.textContent(), /Demo contract clause 3/);
      await checklist.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `${width}-${theme}-recovered.png`), animations: 'disabled' });
    }
    if (mode === 'source_changed') await checklist.getByText('Checklist needs a doctrine review.').waitFor();
    if (mode === 'deal_type_unknown') {
      await summary.waitFor();
      if (!await checklist.evaluate(element => element.open)) await summary.click();
      await checklist.getByText('Confirm the deal type to see its full checklist.').waitFor();
    }
    if (mode === 'long') {
      await checklist.getByText(/Synthetic attorney requirement/).first().waitFor();
      if (!await checklist.evaluate(element => element.open)) await summary.click();
      assert.equal(await checklist.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    }
    assert.equal(await page.evaluate(() => window.checklistReads), reads + 1, `${mode} uses only the existing detail refresh`);
    assert.equal(await page.locator('#recordPanel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await page.locator('#detailUpdateForm').count(), 1, `${mode} retains the update form`);
    assert.equal(await page.getByLabel('Update', { exact: true }).inputValue(), 'Demo unsaved update');
    assert.equal(await page.locator('.deal-opening-snapshot').count(), 1, `${mode} retains deal detail`);
  }
  assert.deepEqual(errors, []);
});
