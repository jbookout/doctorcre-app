import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

let outDir, server, browser, origin;
before(async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  outDir = await temporaryDirectory('overdue-reviews-');
  await buildArtifact({ root, outDir });
  ({ server } = await createQaServer({ buildRoot: join(outDir, 'site') }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const row = { assessment_id: '10000000-0000-4000-8000-000000000001', deal_id: '20000000-0000-4000-8000-000000000001', deal_name: 'Demo Harbor expansion', confirm_verb: 'review-deal-update', assessment: { action: { id: '30000000-0000-4000-8000-000000000001', description: 'Request revised terms', due_on: '2026-10-01' }, update: 'The landlord sent the revised terms today.', quote: 'The landlord sent the revised terms today.', review_required: true } };
for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`Home overdue review at ${width}px in ${theme}`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    t.after(() => page.close());
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `overdue-${width}-${theme}`, viewer: 'joe', reset: true } });
    const writes = [];
    let rows = [row, { ...row, assessment_id: '10000000-0000-4000-8000-000000000002', assessment: { ...row.assessment, action: { ...row.assessment.action, id: '30000000-0000-4000-8000-000000000002', description: 'Ask for the floor plan' }, quote: null, update: 'The floor plan may be ready for review.' } }];
    await page.route('**/mcp', async route => {
      const { name, arguments: args } = route.request().postDataJSON().params;
      let result;
      if (name === 'read-deal-update-reviews') result = { schema_version: 'deal-update-reviews.v1', proposals: rows };
      else if (name === 'review-deal-update') {
        writes.push(args);
        const selected = rows.find(row => row.assessment_id === args.assessment_id);
        rows = rows.filter(row => row !== selected);
        result = { ok: true, decision: args.decision, action_id: selected.assessment.action.id };
      } else return route.continue();
      return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
    });
    await page.goto(`${origin}/?mode=live`);
    const panel = page.locator('#homeOverdueReviews');
    await panel.locator('article').first().waitFor();
    await panel.scrollIntoViewIfNeeded();
    assert.match(await panel.innerText(), /Demo Harbor expansion.*Request revised terms.*The landlord sent the revised terms today.*Mark this overdue task as done/s);
    assert.equal(await panel.locator('a').first().getAttribute('href'), `/deals?deal=${row.deal_id}`);
    assert.equal(await panel.locator('article').count(), width === 390 ? 1 : 2);
    await panel.screenshot({ path: `out/test-artifacts/overdue-reviews/${width}-${theme}.png`, animations: 'disabled' });
    if (width === 390) {
      assert.match(await panel.innerText(), /Show 1 more/);
      await panel.getByRole('button', { name: 'Show 1 more' }).click();
    }
    assert.match(await panel.locator('q').last().innerText(), /The floor plan may be ready/);
    for (const box of await Promise.all((await panel.getByRole('button').all()).map(b => b.boundingBox()))) assert.ok(box.height >= 44);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    await panel.getByRole('button', { name: 'Confirm', exact: true }).first().click();
    await panel.getByText('Task marked done.', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await panel.getByText('Dismissed. Task remains open.', { exact: true }).waitFor();
    assert.deepEqual(writes.map(({ decision, assessment_id }) => ({ decision, assessment_id })), [{ decision: 'resolve', assessment_id: row.assessment_id }, { decision: 'dismiss', assessment_id: '10000000-0000-4000-8000-000000000002' }]);
    assert.ok(writes.every(args => args.idempotency_key && args.reason));
    await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
    await panel.getByText('No overdue reviews.', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  });
}

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`automatic closes on Home at ${width}px in ${theme}`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    t.after(() => page.close());
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `auto-${width}-${theme}`, viewer: 'joe', reset: true } });
    let closed = [{ assessment_id: '10000000-0000-4000-8000-000000000003', deal_id: row.deal_id, deal_name: 'Demo Harbor expansion', action_title: 'Request revised terms', quote: 'The landlord sent the revised terms today.', resolved_at: '2026-10-01T12:00:00Z', undo_possible: true }];
    await page.route('**/mcp', async route => {
      const { name, arguments: args } = route.request().postDataJSON().params;
      let result;
      if (name === 'read-deal-update-reviews') result = { schema_version: 'deal-update-reviews.v1', proposals: [], automatic_resolutions: closed };
      else if (name === 'review-deal-update') { assert.equal(args.decision, 'undo'); closed = []; result = { ok: true, decision: 'undo', action_id: row.assessment.action.id }; }
      else return route.continue();
      await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
    });
    await page.goto(`${origin}/?mode=live`);
    const panel = page.locator('#homeOverdueReviews');
    await panel.getByRole('button', { name: 'Undo' }).waitFor();
    await panel.scrollIntoViewIfNeeded();
    assert.match(await panel.innerText(), /Closed automatically.*Demo Harbor expansion.*Request revised terms.*The landlord sent/s);
    await mkdir('.github/pr-evidence/WR433.S4.J20', { recursive: true });
    await panel.screenshot({ path: `.github/pr-evidence/WR433.S4.J20/${width}-${theme}.png`, animations: 'disabled' });
    await panel.getByRole('button', { name: 'Undo' }).click();
    await panel.getByText('Task reopened.').waitFor();
  });
}
