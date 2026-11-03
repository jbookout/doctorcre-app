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
async function openEditor(t, { width = 390, theme = 'light', refusal = null, submit = false } = {}) {
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
    } else if (name === 'submit-email-draft') {
      writes.push({ name, args });
      result = submit ? { ok: true, proposal_id: row.id, status: 'approved_to_send', version: ++row.version,
        subject: args.subject, body: args.body, sha256: 'a'.repeat(64), to: args.to, cc: args.cc }
        : { error: 'synthetic_send_forbidden' };
    }
    else return route.continue();
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } } });
  });
  await page.goto(`${origin}/review-workflows?mode=live`);
  const card = page.locator('#homeEmailFollowups');
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  await card.getByRole('textbox', { name: 'Subject', exact: true }).fill('Re: Demo plan reviewed');
  await card.getByRole('textbox', { name: 'Message', exact: true }).fill('  I reviewed the plan.\nPlease send the dimensions.  ');
  return { page, card, row, writes };
}
test('half-written reply survives reload without saving or submitting', async t => {
  const { page, card, writes } = await openEditor(t);
  await page.reload();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), '  I reviewed the plan.\nPlease send the dimensions.  ');
  assert.equal(await card.getByRole('textbox', { name: 'Subject', exact: true }).inputValue(), 'Re: Demo plan reviewed');
  assert.equal(writes.length, 0);
  await card.getByRole('button', { name: 'Discard device draft', exact: true }).click();
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Thank you for the plan.');
});
test('offline typing restores after reconnect without replaying a command', async t => {
  const { page, card, writes } = await openEditor(t);
  await page.context().setOffline(true);
  await card.getByRole('textbox', { name: 'Message', exact: true }).fill('An unfinished offline reply');
  await card.getByText('Draft saved on this device. Nothing was sent.', { exact: true }).waitFor();
  await page.context().setOffline(false);
  await page.reload();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'An unfinished offline reply');
  assert.equal(writes.length, 0);
});
test('restored text never silently adopts changed server version or recipients', async t => {
  const { page, card, writes, row } = await openEditor(t);
  row.version = 4; row.reply_draft.to = ['another-demo@example.test'];
  await page.reload();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), '  I reviewed the plan.\nPlease send the dimensions.  ');
  assert.equal(await card.getByRole('button', { name: 'Submit', exact: true }).count(), 0);
  assert.equal(writes.length, 0);
  await card.getByRole('button', { name: 'Reload draft', exact: true }).click();
  await card.getByText('another-demo@example.test', { exact: false }).first().waitFor();
  await card.getByRole('button', { name: 'Save draft', exact: true }).click();
  await card.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(writes[0].args.base_version, 4);
  await page.reload();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  assert.equal(await deviceDraftCount(page), 0);
  assert.equal(await card.getByText(/Device draft restored/).count(), 0);
});
test('storage quota failure leaves edits usable and names the persistence limit', async t => {
  const { page, card, writes } = await openEditor(t);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw Error('synthetic quota'); }; });
  await card.getByRole('textbox', { name: 'Message', exact: true }).fill('Still in this page');
  await card.getByText('Draft is only in this page. Device storage is unavailable.', { exact: true }).waitFor();
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Still in this page');
  assert.equal(writes.length, 0);
});
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

async function deviceDraftCount(page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('doctorcre:reply-device:')).length);
}
for (const width of [390, 1280]) for (const conflict of [false, true]) {
  test(`discard announces saved text and retains keyboard focus at ${width}px conflict=${conflict}`, async t => {
    const { page, card, row, writes } = await openEditor(t, { width });
    if (conflict) row.version++;
    await page.reload();
    await card.getByRole('button', { name: 'Review reply', exact: true }).click();
    await card.getByRole('textbox', { name: 'Message', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').innerText(), 'Discard device draft');
    await page.keyboard.press('Enter');
    assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), row.reply_draft.body);
    assert.equal(await card.locator('[data-device-draft-status][role="status"]').innerText(), 'Device draft discarded. Showing the saved draft.');
    assert.equal(await page.locator(':focus').innerText(), 'Discard device draft');
    assert.equal(await deviceDraftCount(page), 0);
    assert.equal(await card.getByRole('button', { name: 'Save draft', exact: true }).count(), 1);
    assert.equal(writes.length, 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `/tmp/j4-discard-${width}-${conflict}.png` });
  });
}
test('page-only draft becomes saved on device when storage recovers', async t => {
  const { page, card } = await openEditor(t);
  await page.evaluate(() => {
    window.originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw Error('synthetic quota'); };
  });
  const message = card.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Page only');
  await card.getByText('Draft is only in this page. Device storage is unavailable.', { exact: true }).waitFor();
  await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
  await message.fill('Storage recovered');
  await card.getByText('Draft saved on this device. Nothing was sent.', { exact: true }).waitFor();
  await page.reload();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  assert.equal(await message.inputValue(), 'Storage recovered');
});
test('sign out clears device drafts even when the same partner signs in again', async t => {
  const { page, card, row } = await openEditor(t);
  assert.equal(await deviceDraftCount(page), 1);
  await page.locator('#selfAvatar').click();
  await page.getByText('Sign out', { exact: true }).click();
  await page.waitForURL('**/public-shell/session-ended.html');
  assert.equal(await deviceDraftCount(page), 0);
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: 'draft-reauth', viewer: 'joe', reset: true } });
  await page.goto(`${origin}/review-workflows?mode=live`);
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), row.reply_draft.body);
  assert.equal(await card.locator('[data-device-draft-status]').innerText(), '');
  assert.equal(await deviceDraftCount(page), 0);
});
for (const conflict of [false, true]) test(`confirmed submission clears recovered snapshot conflict=${conflict}`, async t => {
  const { page, card, row, writes } = await openEditor(t, { submit: true });
  if (conflict) row.version++;
  await page.reload();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  if (conflict) await card.getByRole('button', { name: 'Reload draft', exact: true }).click();
  await page.clock.install();
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.clock.runFor(10_000);
  await card.getByText('Submitted for sending. Delivery is not yet confirmed.', { exact: true }).waitFor();
  assert.equal(writes.length, 1);
  assert.equal(await deviceDraftCount(page), 0);
  await page.reload();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  assert.equal(await card.getByText(/Device draft restored/).count(), 0);
});

test('reviewed recovery cleanup preserves newer typing from another tab', async t => {
  const { page, card, row } = await openEditor(t);
  row.version++;
  await page.reload();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  await card.getByRole('button', { name: 'Reload draft', exact: true }).click();
  const other = await page.context().newPage();
  t.after(() => other.close());
  await other.goto(origin + '/review-workflows');
  await other.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('doctorcre:reply-device:'));
    const draft = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify({ ...draft, body: 'Newer typing from another tab' }));
  });
  await card.getByRole('button', { name: 'Save draft', exact: true }).click();
  await card.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(await deviceDraftCount(page), 1);
  await page.reload();
  await card.getByRole('button', { name: 'Review reply', exact: true }).click();
  assert.equal(await card.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Newer typing from another tab');
});
