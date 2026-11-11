import nodeTest, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import axe from 'axe-core';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
const test = (name, run) => nodeTest(name, async t => { try { await run(t); } catch (error) { console.error(error); throw error; } });
let outDir;
before(async () => { outDir = temporaryDirectory('inline-review-'); await buildArtifact({ root: process.cwd(), outDir }); await mkdir('test-artifacts/inline-review', { recursive: true }); });
after(async () => { await rm(outDir, { recursive: true, force: true }); });
const id = '00000000-0000-0000-0000-000000000001';
const eventId = '00000000-0000-0000-0000-000000000002';
async function setup(t, { width = 1440, theme = 'light', kind = 'reply_draft', refusal = null, reference = true, missingRecipients = false, initialBody = 'Synthetic body', writeRefusal = null, waitingPerson = false } = {}) {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  const row = { waiting_version: 0, waiting_on: null, item_id: 'one', source_type: kind === 'action' ? 'next_action' : kind === 'reply_draft' ? 'email_proposal' : 'fact_review', source_id: kind === 'fact_review' ? JSON.stringify([id, 'term_months']) : id, source_version: 'v1', source_state: 'needs_attention', title: 'Synthetic review', activity_at: '2026-11-03T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', context_label: null, due_on: null, open_url: null, kind_label: kind === 'action' ? 'Task' : kind === 'reply_draft' ? 'Reply draft' : 'Fact review', merged_source_ids: [], action_id: kind === 'action' ? id : null, action_version: kind === 'action' ? 1 : null, deal_id: null, auto_settled: false, completed_at: null };
  if (waitingPerson) Object.assign(row, { waiting_version: 1, waiting_on: { identity: { kind: 'party', id, available: true, display_name: 'Demo reviewer' }, reason: 'Review the lease terms', evidence: ['call:synthetic'], version: 1 } });
  if (reference) row.review_reference = { kind, item_id: row.item_id, source_version: row.source_version, operations: kind === 'action' ? ['complete-one-action'] : kind === 'reply_draft' ? ['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft'] : ['resolve-fact-review'] };
  let version = 1, subject = 'Synthetic subject', body = initialBody, fail = refusal;
  const calls = [];
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params; calls.push({ name, args });
    let payload = { items: [] };
    if (name === 'read-home-inbox-v5') payload = { ok: true, schema_version: 'home-inbox.v5', auto_settle_enabled: true, working_collapsed: true, truncated: false, limit: 1000, items: [row] };
    if (name === 'read-home-review') {
      if (fail && fail !== 'version_conflict' && fail !== 'uncertain' && fail !== 'after_save_change') payload = { error: fail };
      else if (args.source_version !== row.source_version) payload = { error: 'home_review_stale' };
      else {
        const bound = { proposal_id: id, base_version: version };
        const draft = { subject, body, ...(missingRecipients ? {} : { to: ['demo@example.test'], cc: ['copy@example.test'] }) };
        payload = { ok: true, schema_version: 'home-review.v1', reference: row.review_reference,
          detail: kind === 'action' ? { title: row.title } : kind === 'reply_draft' ? { reply_draft: draft, ...(missingRecipients ? { confirm_verb: null, preview_error: 'email_draft_copy_address_missing' } : {}) } : { canonical_fact: null, observations: [{ id: eventId, value: '60', unit: 'months', source: { document_ref: id, page_start: 1, page_end: 1, cited_text: 'Synthetic signed term is 60 months.' } }] },
          operations: kind === 'action' ? [{ verb: 'complete-one-action', args: { action_id: id, base_version: version } }] : kind === 'reply_draft' ? [{ verb: 'edit-email-draft', args: bound }, { verb: 'dismiss-email-proposal', args: bound }, ...(missingRecipients ? [] : [{ verb: 'submit-email-draft', args: { ...bound, ...draft } }])] : [{ verb: 'resolve-fact-review', args: { entity_ref: id, fact_key: 'term_months', base_version: 0, review_version: 'r1' }, decisions: ['approve', 'correct', 'reject'] }] };
      }
    }
    if (['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft', 'complete-one-action', 'resolve-fact-review', 'reopen-one-action'].includes(name)) {
      if (writeRefusal) return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ error: writeRefusal }) }] } } });
      if (fail === 'uncertain') { fail = null; return route.abort(); }
      if (fail === 'version_conflict') { fail = null; version++; row.source_version = 'v2'; row.review_reference.source_version = 'v2'; payload = { error: 'version_conflict' }; }
      else {
        version++; row.source_version = `v${version}`; row.review_reference.source_version = row.source_version;
        if (name === 'edit-email-draft') { subject = args.subject; body = args.body; }
        else if (name === 'reopen-one-action') Object.assign(row, { completed_at: null, action_version: version, source_state: 'needs_attention', disposition: 'inbox', section: 'inbox', auto_settled: false });
        else Object.assign(row, { completed_at: new Date().toISOString(), waiting_on: null, waiting_version: row.waiting_version + 1, action_version: kind === 'action' ? version : null, source_state: 'done', disposition: 'settled', section: 'settled', auto_settled: true });
        payload = kind === 'action' ? { ok: true, action_id: id, status: name === 'reopen-one-action' ? 'open' : 'done', version, completion_event_id: eventId } : kind === 'fact_review' ? { ok: true, schema_version: 'fact-review.v1', review_receipt: { entity_ref: id, fact_key: 'term_months' } } : { ok: true, proposal_id: id, version };
        if (fail === 'after_save_change' && name === 'edit-email-draft') { version++; row.source_version = `v${version}`; row.review_reference.source_version = row.source_version; subject = 'Updated elsewhere'; fail = null; }
      }
    }
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  page.setDefaultTimeout(5000);
  await page.goto(`${server.origin}/?mode=live`);
  await page.locator('[data-inbox-row="one"]').waitFor();
  return { page, calls, row, panel: page.getByRole('region', { name: 'Review Synthetic review', exact: true }) };
}
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`inline reply edits, saves and explicitly submits ${width} ${theme}`, async t => {
  const { page, panel, calls } = await setup(t, { width, theme });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByLabel('Subject', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Mark done', exact: true }).count(), 0);
  assert.equal(calls.filter(c => ['edit-email-draft', 'submit-email-draft'].includes(c.name)).length, 0);
  await panel.getByLabel('Subject', { exact: true }).fill('Reviewed exact subject');
  await panel.getByLabel('Message', { exact: true }).fill('Reviewed exact body');
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(calls.filter(c => c.name === 'submit-email-draft').length, 0);
  assert.equal(calls.filter(c => c.name === 'edit-email-draft').length, 1);
  await page.addScriptTag({ content: axe.source });
  assert.deepEqual(await panel.evaluate(async node => (await window.axe.run(node)).violations), []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `test-artifacts/inline-review/reply-${width}-${theme}.png`, fullPage: true });
  await panel.getByRole('button', { name: 'Submit reply for sending', exact: true }).click();
  await panel.getByText('Reply submitted to the existing sender. Delivery is not yet confirmed.', { exact: true }).waitFor();
  const writes = calls.filter(c => c.name === 'submit-email-draft'); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args.to, ['demo@example.test']); assert.deepEqual(writes[0].args.cc, ['copy@example.test']);
  assert.equal(writes[0].args.subject, 'Reviewed exact subject'); assert.equal(writes[0].args.body, 'Reviewed exact body');
  assert.equal(page.url().includes('/inbox'), false);
  await panel.getByRole('button', { name: 'Close review', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-inbox-row="one"]')?.contains(document.activeElement));
});
test('conflict keeps text and reload binds a fresh version before another deliberate save', async t => {
  const { page, panel, calls } = await setup(t, { refusal: 'version_conflict' });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByLabel('Message', { exact: true }).fill('Keep my local edits');
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByRole('button', { name: 'Review updated card', exact: true }).click();
  await panel.getByText('Updated evidence loaded. Your edits are kept. Review the evidence and recipients before submitting again.', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Message', { exact: true }).inputValue(), 'Keep my local edits');
  assert.equal(calls.filter(c => c.name === 'edit-email-draft').length, 1);
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  const writes = calls.filter(c => c.name === 'edit-email-draft');
  assert.equal(writes[1].args.base_version, 2); assert.notEqual(writes[0].args.idempotency_key, writes[1].args.idempotency_key);
});
test('uncertain write retries only the identical frozen request', async t => {
  const { page, panel, calls } = await setup(t, { refusal: 'uncertain' });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByRole('button', { name: 'Retry same review request', exact: true }).click();
  await panel.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  const writes = calls.filter(c => c.name === 'edit-email-draft'); assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
});
for (const refusal of ['home_review_stale', 'home_review_resolved', 'home_review_unsupported', 'human_only_verb_requires_verified_partner']) test(`review safely refuses ${refusal}`, async t => {
  const { page, panel, calls } = await setup(t, { refusal });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByText(refusal === 'home_review_stale' ? 'This card changed. Your edits are kept. Review the updated card before submitting again.' : refusal === 'home_review_resolved' ? 'This card is already resolved. Refresh the inbox to see its current state.' : refusal === 'human_only_verb_requires_verified_partner' ? 'Sign in as the owning verified partner to review this card.' : 'This card cannot be reviewed here. Open its source record.', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Save draft', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0); assert.equal(calls.filter(c => c.name === 'submit-email-draft').length, 0);
});
test('task review completes one canonical action and retains Undo receipt', async t => {
  const { page, panel, calls } = await setup(t, { kind: 'action' });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByRole('button', { name: 'Mark done', exact: true }).click();
  await panel.getByText('This card is confirmed. Its current state is shown in your inbox.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Close review', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Undone.', { exact: false }).waitFor();
  assert.equal(calls.filter(c => c.name === 'complete-one-action').length, 1);
  assert.equal(calls.find(c => c.name === 'reopen-one-action').args.completion_event_id, eventId);
});
for (const decision of ['Approve a sourced value', 'Correct with a source', 'Reject this review']) test(`fact review ${decision} calls its existing owner`, async t => {
  const { page, panel, calls } = await setup(t, { kind: 'fact_review' });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByLabel('Decision', { exact: true }).selectOption({ label: decision });
  await panel.getByLabel('Reason', { exact: true }).fill('Synthetic reviewed source');
  if (decision === 'Correct with a source') { await panel.getByLabel('Corrected value', { exact: true }).fill('72'); await panel.getByLabel('Cited text', { exact: true }).fill('Synthetic corrected term is 72 months.'); }
  await panel.getByRole('button', { name: 'Save review', exact: true }).click();
  await panel.getByText('This card is confirmed. Its current state is shown in your inbox.', { exact: true }).waitFor();
  const writes = calls.filter(c => c.name === 'resolve-fact-review'); assert.equal(writes.length, 1);
  assert.equal(writes[0].args.fact_key, 'term_months');
  if (decision === 'Approve a sourced value') assert.equal(writes[0].args.observation_id, eventId);
  if (decision === 'Correct with a source') assert.equal(writes[0].args.correction.value, '72');
});
test('older producer without references keeps a navigable card', async t => {
  const { page, calls } = await setup(t, { reference: false });
  assert.equal(await page.getByRole('button', { name: 'Review card', exact: true }).count(), 0);
  assert.ok(await page.getByRole('link', { name: 'Synthetic review', exact: true }).getAttribute('href'));
  assert.equal(calls.filter(c => c.name === 'read-home-review').length, 0);
});
test('keyboard review and rapid repeated activation make one deliberate write', async t => {
  const { page, panel, calls } = await setup(t);
  const opener = page.getByRole('button', { name: 'Review card', exact: true });
  await opener.focus(); await page.keyboard.press('Enter');
  const save = panel.getByRole('button', { name: 'Save draft', exact: true });
  await save.evaluate(button => { button.click(); button.click(); });
  await panel.getByText('Saved as a draft. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(calls.filter(c => c.name === 'edit-email-draft').length, 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Review card');
});
test('closing a loading review rejects late detail and sends no domain command', async t => {
  const { page, panel, calls } = await setup(t);
  let held;
  await page.route('**/mcp', route => {
    if (route.request().postDataJSON().params.name === 'read-home-review') { held = route; return; }
    return route.fallback();
  });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByText('Loading current evidence…', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await held?.fulfill({ json: { error: 'home_review_stale' } }).catch(() => {});
  assert.equal(await panel.count(), 0);
  assert.equal(calls.filter(c => ['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft'].includes(c.name)).length, 0);
});

test('a newer draft after the save receipt requires explicit review and preserves local text', async t => {
  const { page, panel, calls } = await setup(t, { refusal: 'after_save_change' });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByLabel('Message', { exact: true }).fill('Keep the reviewed local body');
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByRole('button', { name: 'Review updated card', exact: true }).click();
  await panel.getByText('Updated evidence loaded. Your edits are kept. Review the evidence and recipients before submitting again.', { exact: true }).waitFor();
  await panel.getByText('Current saved reply', { exact: true }).click();
  await panel.getByText('Updated elsewhere', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Message', { exact: true }).inputValue(), 'Keep the reviewed local body');
  assert.equal(calls.filter(c => c.name === 'edit-email-draft').length, 1);
});

for (const initialBody of ['Synthetic body', '']) test(`decline ignores invalid content with initial body ${initialBody ? 'present' : 'empty'}`, async t => {
  const { page, panel, calls } = await setup(t, { width: 390, initialBody });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByLabel('Message', { exact: true }).fill('');
  await panel.getByLabel('Subject', { exact: true }).fill('');
  await panel.getByLabel('Reason for declining', { exact: true }).fill('Decline this synthetic draft');
  await panel.getByRole('button', { name: 'Decline draft', exact: true }).click();
  await panel.getByText('This card is confirmed. Its current state is shown in your inbox.', { exact: true }).waitFor();
  const writes = calls.filter(c => c.name === 'dismiss-email-proposal');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args.reason, 'Decline this synthetic draft');
  assert.equal(calls.filter(c => ['edit-email-draft', 'submit-email-draft'].includes(c.name)).length, 0);
});
for (const action of ['Save draft', 'Decline draft']) test(`unavailable send recipients preserve ${action}`, async t => {
  const { page, panel, calls } = await setup(t, { width: 390, missingRecipients: true });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByText('Sending unavailable: email_draft_copy_address_missing', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Submit reply for sending', exact: true }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: 'Save draft', exact: true }).count(), 1);
  assert.equal(await panel.getByRole('button', { name: 'Decline draft', exact: true }).count(), 1);
  await panel.getByLabel('Message', { exact: true }).fill('Reviewed without recipients');
  await panel.getByLabel('Reason for declining', { exact: true }).fill('No reply needed');
  await panel.getByRole('button', { name: action, exact: true }).click();
  await panel.getByText(action === 'Save draft' ? 'Saved as a draft. Nothing was sent.' : 'This card is confirmed. Its current state is shown in your inbox.', { exact: true }).waitFor();
  const writes = calls.filter(c => ['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft'].includes(c.name));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, action === 'Save draft' ? 'edit-email-draft' : 'dismiss-email-proposal');
  assert.equal('to' in writes[0].args || 'cc' in writes[0].args, false);
});
for (const writeRefusal of ['human_only_verb_requires_verified_partner', 'home_review_resolved']) test(`submitted review refuses ${writeRefusal}`, async t => {
  const { page, panel, calls } = await setup(t, { writeRefusal });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await panel.getByText(writeRefusal === 'home_review_resolved' ? 'This card is already resolved. Refresh the inbox to see its current state.' : 'Sign in as the owning verified partner to review this card.', { exact: true }).waitFor();
  assert.equal(calls.filter(c => c.name === 'edit-email-draft').length, 1);
  assert.equal(await panel.getByRole('button', { name: 'Save draft', exact: true }).count(), 0);
});
test('Escape closes unsaved edits without a write and returns focus', async t => {
  const { page, panel, calls } = await setup(t);
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByLabel('Message', { exact: true }).fill('Unsaved local changes');
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent === 'Review card');
  assert.equal(calls.filter(c => ['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft'].includes(c.name)).length, 0);
});
test('save and send still require valid reply content', async t => {
  const { page, panel, calls } = await setup(t);
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  for (const field of ['Message', 'Subject']) {
    await panel.getByLabel(field, { exact: true }).fill('');
    for (const name of ['Save draft', 'Submit reply for sending']) await panel.getByRole('button', { name, exact: true }).click();
    assert.equal(calls.filter(c => ['edit-email-draft', 'submit-email-draft'].includes(c.name)).length, 0);
    await panel.getByLabel(field, { exact: true }).fill('Reviewed content');
  }
});

test('decline requires a nonblank reason even when content is empty', async t => {
  const { page, panel, calls } = await setup(t, { initialBody: '' });
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  await panel.getByLabel('Reason for declining', { exact: true }).fill('   ');
  await panel.getByRole('button', { name: 'Decline draft', exact: true }).click();
  await panel.getByText('Give a reason before declining this draft.', { exact: true }).waitFor();
  assert.equal(calls.filter(c => c.name === 'dismiss-email-proposal').length, 0);
});

for (const width of [390, 1440]) test(`recorded waiting person clears on inline completion and Undo stays unknown ${width}`, async t => {
  const { page, panel, calls } = await setup(t, { width, kind: 'action', waitingPerson: true });
  const row = page.locator('[data-inbox-row="one"]');
  await row.getByText('Waiting on Demo reviewer', { exact: true }).waitFor();
  await row.getByText('Review the lease terms', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review card', exact: true }).click();
  assert.equal(await row.getByRole('button', { name: 'Correct waiting person' }).isDisabled(), true);
  await panel.getByRole('button', { name: 'Mark done', exact: true }).click();
  await panel.getByText('This card is confirmed. Its current state is shown in your inbox.', { exact: true }).waitFor();
  assert.equal(await row.getByText(/Waiting on/).count(), 0);
  await panel.getByRole('button', { name: 'Close review', exact: true }).click();
  const done = page.getByRole('region', { name: 'Done today', exact: true });
  await done.locator('[data-inbox-row="one"]').waitFor();
  await page.screenshot({ path: `test-artifacts/inline-review/waiting-done-${width}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await row.getByText('Waiting on someone · Not recorded', { exact: true }).waitFor();
  assert.equal(await row.getByText('Waiting on Demo reviewer', { exact: true }).count(), 0);
  assert.equal(calls.filter(c => c.name === 'complete-one-action').length, 1);
  assert.equal(calls.find(c => c.name === 'reopen-one-action').args.completion_event_id, eventId);
  assert.equal(calls.filter(c => ['set-home-waiting', 'clear-home-waiting'].includes(c.name)).length, 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `test-artifacts/inline-review/waiting-undo-${width}.png`, fullPage: true });
});
