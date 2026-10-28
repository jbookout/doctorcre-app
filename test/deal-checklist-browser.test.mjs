import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'out/test-artifacts/deal-checklist');
let outDir, server, browser, origin;
before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'deal-checklist-'));
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  ({ server } = await createQaServer({ buildRoot: join(outDir, 'site') }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  await mkdir(evidence, { recursive: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`signed-in checklist preserves item disclosures and hides empty refreshes at ${width}px in ${theme}`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 960 }, timezoneId: 'America/Chicago', reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `checklist-${width}-${theme}`, viewer: 'joe', reset: true } })).status(), 200);
  const response = await page.request.post(`${origin}/mcp`, { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deal-room-board', arguments: {} } } });
  const envelope = await response.json();
  assert.equal(JSON.parse(envelope.result.content[0].text).actor, 'joe');
  await page.clock.install();
  await page.goto(`${origin}/deals?mode=live`);
  await page.locator('.kanban-card').first().waitFor();
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js'); const get = state.client.getDeal;
    window.checklistMode = 'due';
    state.client.getDeal = async (...args) => {
      const detail = await get(...args);
      const complete = window.checklistMode === 'complete';
      const review = { id: 'review', label: 'Demo attorney review', status: complete ? 'complete' : 'due', due_on: '2026-10-20', evidence_ref: 'Demo contract clause 3', source: { document: 'deal-room-kit', version: 1 } };
      const lease = { id: 'lease', label: 'Executed lease', status: 'not_recorded', evidence_ref: null, source: { document: 'deal-room-kit', version: 1 } };
      return { ...detail, checklist: window.checklistMode === 'absent' ? null : {
        schema_version: 'deal-checklist.v1', template_state: window.checklistMode === 'unavailable' ? 'unavailable' : 'current',
        due_items: complete || window.checklistMode === 'unavailable' ? [] : [review],
        phases: ['empty', 'unavailable'].includes(window.checklistMode) ? [] : [{ id: 'legal', label: 'Legal / lease', items: complete ? [lease, review] : [review, lease] }],
      } };
    };
  });
  await page.locator('.card-open').first().click();
  const checklist = page.locator('.deal-checklist');
  const summary = checklist.locator(':scope > summary');
  await summary.waitFor();
  assert.match(await summary.textContent(), /Demo attorney review/);
  assert.equal(await checklist.evaluate(element => element.open), false);
  const dueBox = await summary.boundingBox();
  const panelBox = await page.locator('#recordPanel').boundingBox();
  assert.ok(dueBox.y >= panelBox.y && dueBox.y + dueBox.height <= panelBox.y + panelBox.height, 'the next due item is visible when the deal opens');
  await checklist.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, `${width}-${theme}-due.png`), animations: 'disabled' });
  await summary.click();
  const review = checklist.locator('[data-checklist-item="review"] details');
  await review.locator('summary').click();
  await page.getByLabel('Update', { exact: true }).fill('Demo unsaved update');
  await page.evaluate(() => { window.checklistMode = 'complete'; });
  await page.clock.fastForward(60_001);
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
  for (const mode of ['empty', 'due', 'absent', 'due', 'unavailable', 'due']) {
    await page.evaluate(mode => { window.checklistMode = mode; }, mode);
    await page.clock.fastForward(60_001);
    await page.locator('[data-refresh-detail]').click();
    await page.waitForFunction(visible => !!document.querySelector('.deal-checklist') === visible, mode === 'due');
    assert.equal(await page.locator('#detailUpdateForm').count(), 1, `${mode} retains the update form`);
    assert.equal(await page.getByLabel('Update', { exact: true }).inputValue(), 'Demo unsaved update');
    assert.equal(await page.locator('.deal-opening-snapshot').count(), 1, `${mode} retains deal detail`);
  }
  assert.deepEqual(errors, []);
});
