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
  outDir = await temporaryDirectory('email-followups-');
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

const draft = () => ({ id: '10000000-0000-4000-8000-000000000003', version: 3, kind: 'reply_draft', status: 'pending',
  deal: 'qa-deal-1', deal_name: 'Demo Harbor expansion', preview: null, preview_error: null,
  source: { activity_id: '30000000-0000-4000-8000-000000000003', sender: 'Demo Owner', subject: 'Demo floor plan', evidence_quote: 'Please review the floor plan.', occurred_at: '2026-10-27T12:00:00Z' },
  confirm_verb: 'submit-email-draft', reply_draft: { subject: 'Re: Demo floor plan', body: 'Thank you for the plan.', owner: 'joe', to: ['demo-correspondent@example.test'], cc: ['demo-dell@example.test'] } });
async function openEditor(t, { width = 390, theme = 'light', refusal = null } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  t.after(() => page.close());
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `draft-save-${width}-${theme}`, viewer: 'joe', reset: true } });
  const row = draft(), writes = [];
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    let result;
    if (name === 'list-email-proposals') result = { schema_version: 'email-proposals.v1', proposals: [row], send: false, more: false, next_cursor: null };
    else if (name === 'edit-email-draft') {
      writes.push({ name, args });
      if (refusal === 'signed-out') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
      if (refusal) result = { error: refusal, current_version: 4 };
      else { row.version++; row.reply_draft.subject = args.subject; row.reply_draft.body = args.body;
        result = { ok: true, proposal_id: row.id, version: row.version, subject: args.subject, body: args.body }; }
    } else if (name === 'submit-email-draft') { writes.push({ name, args }); result = { error: 'synthetic_send_forbidden' }; }
    else return route.continue();
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  });
  await page.goto(`${origin}/?mode=live`);
  const card = page.locator('#homeEmailFollowups');
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  await card.getByRole('textbox', { name: 'Subject', exact: true }).fill('Re: Demo plan reviewed');
  await card.getByRole('textbox', { name: 'Message', exact: true }).fill('  I reviewed the plan.\nPlease send the dimensions.  ');
  return { page, card, row, writes };
}
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`partner saves draft without sending at ${width}px ${theme}`, async t => {
  const { page, card, row, writes } = await openEditor(t, { width, theme });
  await card.getByRole('button', { name: 'Save draft', exact: true }).click();
  await card.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'edit-email-draft');
  const { idempotency_key, ...args } = writes[0].args;
  assert.ok(idempotency_key);
  assert.deepEqual(args, { proposal_id: row.id, base_version: 3, subject: 'Re: Demo plan reviewed', body: '  I reviewed the plan.\nPlease send the dimensions.  ' });
  await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
  await card.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), args.body);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const control of await card.locator('input, textarea, button').all()) {
    const box = await control.boundingBox();
    if (box) assert.ok(box.x >= 0 && box.x + box.width <= width + 1, 'editor controls stay inside viewport');
  }
  await mkdir('.github/pr-evidence/WR635.S1.J12', { recursive: true });
  await card.evaluate(node => window.scrollTo({ top: window.scrollY + node.getBoundingClientRect().top - 100, behavior: 'instant' }));
  await page.screenshot({ path: `.github/pr-evidence/WR635.S1.J12/saved-${width}-${theme}.png`, animations: 'disabled' });
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), args.body);
  await card.getByRole('textbox', { name: 'Message', exact: true }).fill('Second saved draft');
  await card.getByRole('button', { name: 'Save draft', exact: true }).click();
  await card.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(writes[1].args.base_version, 4);
  assert.equal(writes.filter(call => call.name === 'submit-email-draft').length, 0);
});
test('draft version conflict preserves edits and requires reload without automatic retry', async t => {
  const { page, card, writes } = await openEditor(t, { refusal: 'version_conflict' });
  await card.getByRole('button', { name: 'Save draft', exact: true }).click();
  await card.getByText('This draft changed. Reload the draft and review it before saving again.', { exact: true }).waitFor();
  assert.match(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), /I reviewed the plan/);
  assert.equal(await card.getByRole('button', { name: 'Save draft', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Refresh Home', exact: true }).click();
  await card.getByRole('button', { name: 'Reload draft', exact: true }).waitFor();
  assert.equal(writes.length, 1);
  await card.getByRole('button', { name: 'Reload draft', exact: true }).click();
  await card.getByRole('button', { name: 'Save draft', exact: true }).waitFor();
  assert.equal(writes.length, 1);
});
test('signed-out save refuses and clears private draft content', async t => {
  const { card, writes } = await openEditor(t, { refusal: 'signed-out' });
  await card.getByRole('button', { name: 'Save draft', exact: true }).click();
  await card.page().getByText('Sign in to open your workspace.', { exact: true }).waitFor();
  assert.equal(await card.page().getByRole('textbox').count(), 0);
  assert.doesNotMatch(await card.page().locator('body').innerText(), /I reviewed|Saved as a draft/);
  assert.equal(writes.length, 1);
});
