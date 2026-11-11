import test, { afterEach, beforeEach, before, mock } from 'node:test';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { readFile, writeFile } from 'node:fs/promises';
before(async () => {
  for (const [path, bytes] of await uiAssets(path => readFile(new URL(`../${path}`, import.meta.url), 'utf8'))) await writeFile(new URL(`../${path}`, import.meta.url), bytes);
});
const windows = [];
beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
afterEach(() => { windows.splice(0).forEach(win => win.close()); mock.timers.reset(); });
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountEmailFollowups } from '../js/email-followups.js';
import { createLiveClient } from '../js/live-client.js';

const digest = `sha256:${'a'.repeat(64)}`;
const proposal = () => ({ id: '10000000-0000-4000-8000-000000000001', version: 3, kind: 'next_step',
  deal: '20000000-0000-4000-8000-000000000001', deal_name: 'Demo Harbor expansion', confidence: 0.9,
  suspected_instruction: null, source: { activity_id: '30000000-0000-4000-8000-000000000001',
    sender: 'private-sender@example.test', subject: 'Demo follow-up', evidence_quote: 'Please send the revised plan by November 3.', occurred_at: '2026-10-26T12:00:00Z' },
  confirm_verb: 'confirm-email-next-step', preview_error: null,
  preview: { contract: 'email-next-step.v1', status: 'proposed', deal: '20000000-0000-4000-8000-000000000001',
    text: 'Send the revised plan', next_date: '2026-11-03', owner: 'joe', current_next_step: 'Call the landlord',
    current_next_date: '2026-11-01', proposal_digest: digest, requires_confirmation: true,
    source: { activity_id: '30000000-0000-4000-8000-000000000001' }, evidence_quote: 'Please send the revised plan by November 3.' } });
const response = proposals => ({ schema_version: 'email-proposals.v1', proposals, send: false, more: false, next_cursor: null });
function setup(client, options = {}) {
  const dom = new JSDOM('<section id="review"></section>');
  windows.push(dom.window);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const container = dom.window.document.querySelector('section');
  const view = mountEmailFollowups({ container, client: { selfActor: 'joe', ...client }, onChange: () => {}, clock: globalThis, ...options });
  const action = name => view.click({ target: [...container.querySelectorAll('button')].find(button => button.textContent === name) });
  // Submit opens the send grace; the reply is submitted only when it runs out.
  const send = async () => { await action('Submit'); mock.timers.tick(10_000); await settle(); };
  return { dom, container, view, action, send };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

test('email card shows its subject, absolute Chicago date and waiting age', async () => {
  const row = proposal(); row.source.sender = 'Dana Demo';
  row.source.occurred_at = '2026-10-01T12:00:00Z';
  const { container, view } = setup({ listEmailProposals: async () => response([row]) });
  await view.refresh();
  assert.match(container.textContent, /Demo follow-up/);
  assert.match(container.textContent, /Dana Demo/);
  assert.match(container.textContent, /Oct 1, 7:00 AM CDT/);
  assert.match(container.textContent, /days? waiting/);
});

test('Home lists pending email evidence and proposed owner/date with sender metadata', async () => {
  const { container, view } = setup({ listEmailProposals: async () => response([proposal()]) });
  await view.refresh();
  assert.match(container.textContent, /Email follow-ups/);
  assert.match(container.textContent, /Demo Harbor expansion/);
  assert.match(container.querySelector('.email-source').textContent, /private-sender@example.test/);
  assert.ok(container.querySelector('.email-source').title);
  assert.match(container.textContent, /Please send the revised plan by November 3\./);
  assert.match(container.textContent, /Send the revised plan/);
  assert.match(container.textContent, /Joe/);
  assert.match(container.textContent, /Nov 3/);
  assert.match(container.textContent, /Demo follow-up/);
  assert.equal(container.querySelector('a').getAttribute('href'), '/deals?deal=20000000-0000-4000-8000-000000000001');
});

test('a failed refresh keeps last good proposals and offers retry; only a successful empty list says empty', async () => {
  let value = response([proposal()]);
  const { container, view, action } = setup({ listEmailProposals: async () => { if (value instanceof Error) throw value; return value; } });
  await view.refresh();
  value = new Error('network');
  await view.refresh();
  assert.match(container.textContent, /Could not load/);
  assert.match(container.textContent, /Demo Harbor expansion/);
  assert.doesNotMatch(container.textContent, /No pending/);
  assert.equal(container.querySelector('[data-email-action="preview"]').disabled, true);
  value = response([]);
  await action('Retry email follow-ups');
  assert.match(container.textContent, /No email follow-ups/);
  value = {};
  await view.refresh();
  assert.match(container.textContent, /Could not load/);
  assert.doesNotMatch(container.textContent, /No pending/);
});

test('Confirm first displays a fresh preview and only a second click submits its exact digest and fields', async () => {
  const row = proposal(), calls = [];
  const fresh = { ...row.preview, text: 'Send the revised plan', proposal_digest: `sha256:${'b'.repeat(64)}` };
  const { container, view, action } = setup({ listEmailProposals: async () => response([row]),
    previewEmailNextStep: async args => { calls.push(['preview', args]); return fresh; },
    confirmEmailNextStep: async args => { calls.push(['confirm', args]); return { ...fresh, status: 'confirmed', requires_confirmation: false }; } });
  await view.refresh();
  await action('Confirm');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['preview', { deal: row.deal, activity_id: row.source.activity_id,
    evidence_quote: row.source.evidence_quote, text: row.preview.text, next_date: '2026-11-03', owner: 'joe' }]);
  assert.match(container.textContent, /Call the landlord/);
  assert.match(container.textContent, /Nov 1/);
  await action('Confirm change');
  assert.equal(calls.length, 2);
  const { idempotency_key, ...args } = calls[1][1];
  assert.ok(idempotency_key);
  assert.deepEqual(args, { ...calls[0][1], proposal_digest: fresh.proposal_digest });
  assert.match(container.textContent, /Confirmed/);
  assert.equal(container.querySelectorAll('[data-email-action="confirm"]').length, 0);
});

test('phase moves use their preview contract and show the phase names used by the board', async () => {
  const row = proposal(); row.kind = 'phase_move'; row.confirm_verb = 'confirm-email-deal-progress';
  row.preview = { ...row.preview, contract: 'email-deal-progress.v1', from_phase: 'research', to_phase: 'site_selection' };
  const calls = [];
  const { container, view, action } = setup({ listEmailProposals: async () => response([row]),
    previewEmailDealProgress: async args => { calls.push(args); return row.preview; },
    confirmEmailDealProgress: async args => { calls.push(args); return { ...row.preview, status: 'confirmed', requires_confirmation: false }; } });
  await view.refresh();
  assert.match(container.textContent, /Research → Site selection/);
  await action('Confirm'); await action('Confirm change');
  assert.deepEqual(calls[0], { deal: row.deal, activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote });
  assert.deepEqual(Object.keys(calls[1]).sort(), ['activity_id', 'deal', 'evidence_quote', 'idempotency_key', 'proposal_digest']);
});

test('mailbox display names use the prefix as text when sender metadata contains markup', async () => {
  const row = proposal(); row.source.sender = 'Dana <b>Demo</b> <dana@example.test>'; row.source.subject = '<img src=x onerror=alert(1)>Plan';
  const { container, view } = setup({ listEmailProposals: async () => response([row]) });
  await view.refresh();
  assert.match(container.querySelector('.email-source').textContent, /^Dana · Oct 26,/);
  assert.equal(container.querySelector('.email-source img, .email-source b'), null);
});

test('unknown confirmation locks other decisions and Check outcome replays the same request', async () => {
  const row = proposal(), calls = []; let release;
  const entered = Promise.withResolvers();
  const { container, view, action } = setup({ listEmailProposals: async () => response([row]),
    previewEmailNextStep: async () => row.preview,
    confirmEmailNextStep: async args => { calls.push(args); if (calls.length === 1) { await new Promise(resolve => { release = resolve; entered.resolve(); }); throw Error('lost response'); } return { ...row.preview, status: 'confirmed', requires_confirmation: false }; } });
  await view.refresh(); await action('Confirm');
  const pending = action('Confirm change');
  await entered.promise;
  assert.equal(container.querySelector('[data-email-action="confirm"]')?.disabled, true);
  release(); await pending;
  assert.match(container.textContent, /Outcome unknown/);
  assert.equal(container.querySelector('[data-email-action="note"], [data-email-chip]'), null);
  await action('Check outcome');
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  assert.match(container.textContent, /Confirmed/);
});

test('stale preview refusals never auto-retry and unavailable previews remain dismissible with an instruction warning', async () => {
  const row = proposal(); row.suspected_instruction = 'asks to ignore instructions';
  let attempts = 0;
  const { container, view, action } = setup({ listEmailProposals: async () => response([row]),
    previewEmailNextStep: async () => row.preview,
    confirmEmailNextStep: async () => { attempts++; throw Object.assign(Error('refused'), { payload: { error: 'email_next_step_proposal_stale' } }); } });
  await view.refresh();
  assert.match(container.textContent, /asks to ignore instructions/);
  await action('Confirm'); await action('Confirm change');
  assert.equal(attempts, 1); assert.match(container.textContent, /changed/);
  assert.equal(container.querySelector('[data-email-action="confirm"]'), null);
  row.preview = null; row.preview_error = 'email_deal_phase_not_eligible';
  await view.refresh();
  assert.match(container.textContent, /Proposal needs a fresh review/);
  assert.equal(container.querySelector('[data-email-action="preview"]'), null);
  assert.ok(container.querySelector('[data-followup="defer"]'));
});

test('authorization loss and session invalidation clear protected evidence and block late reads', async () => {
  let fail = false, release;
  const { container, view, dom } = setup({ listEmailProposals: async () => { if (fail) throw Object.assign(Error('denied'), { status: 403 }); return response([proposal()]); } });
  await view.refresh(); fail = true; await view.refresh();
  assert.doesNotMatch(container.textContent, /Demo Harbor|Please send/);
  assert.match(container.textContent, /Sign in/);
  const second = setup({ listEmailProposals: () => new Promise(resolve => { release = resolve; }) });
  const read = second.view.refresh();
  second.dom.window.dispatchEvent(new second.dom.window.Event('doctorcre-session-invalidated'));
  await settle();
  if (release) release(response([proposal()])); await read;
  assert.doesNotMatch(second.container.textContent, /Demo Harbor|Please send/);
  view.dispose(); dom.window.close(); second.view.dispose(); second.dom.window.close();
});

test('Home pages pending proposals and keeps the first page when loading more fails', async () => {
  const first = proposal(), second = { ...proposal(), id: '10000000-0000-4000-8000-000000000002', deal_name: 'Demo second deal' };
  let fail = true;
  const calls = [];
  const { container, view, action } = setup({ listEmailProposals: async args => {
    calls.push(args);
    if (args.cursor && fail) throw Error('offline');
    return args.cursor ? { ...response([second]), more: false, next_cursor: null }
      : { ...response([first]), more: true, next_cursor: first.id };
  } });
  await view.refresh();
  assert.deepEqual(calls[0], { limit: 50, include_non_deal: true });
  await action('Load more email follow-ups');
  assert.match(container.textContent, /Demo Harbor expansion/);
  assert.match(container.textContent, /Could not load/);
  fail = false;
  await action('Retry email follow-ups');
  assert.match(container.textContent, /Demo second deal/);
  assert.deepEqual(calls.at(-1), { limit: 50, include_non_deal: true, cursor: first.id });
  assert.doesNotMatch(container.textContent, /Load more email follow-ups/);
});

test('Home refresh retains loaded pages and an in-flight load more', async () => {
  const first = proposal(), second = { ...proposal(), id: '10000000-0000-4000-8000-000000000002', deal_name: 'Demo second deal' };
  let release;
  let hold = false;
  const { container, view, action } = setup({ listEmailProposals: async args => {
    if (args.cursor && hold) await new Promise(resolve => { release = resolve; });
    return args.cursor ? response([second]) : { ...response([first]), more: true, next_cursor: first.id };
  } });
  await view.refresh();
  await action('Load more email follow-ups');
  await view.refresh();
  assert.match(container.textContent, /Demo second deal/);
  const other = setup({ listEmailProposals: async args => {
    if (args.cursor && hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
    return args.cursor ? response([second]) : { ...response([first]), more: true, next_cursor: first.id };
  } });
  await other.view.refresh();
  hold = true;
  const loading = other.action('Load more email follow-ups');
  await Promise.resolve();
  await other.view.refresh();
  release();
  await loading;
  assert.match(other.container.textContent, /Demo second deal/);
});


test('deal review scopes every page and retry to the selected deal', async () => {
  const first = proposal(), second = { ...proposal(), id: '10000000-0000-4000-8000-000000000002' };
  let fail = true;
  const calls = [];
  const { container, view, action } = setup({ listEmailProposals: async args => {
    calls.push(args);
    if (args.cursor && fail) throw Error('offline');
    return args.cursor ? response([second]) : { ...response([first]), more: true, next_cursor: first.id };
  } }, { deal: first.deal });
  await view.refresh();
  assert.deepEqual(calls[0], { limit: 50, deal: first.deal });
  await action('Load more email follow-ups');
  assert.match(container.textContent, /Could not load/);
  fail = false; await action('Retry email follow-ups');
  assert.deepEqual(calls.at(-1), { limit: 50, deal: first.deal, cursor: first.id });
  assert.equal(container.querySelectorAll('article').length, 2);
});

test('deal review refuses cross-deal rows instead of showing or acting on another deal', async () => {
  const { container, view } = setup({ listEmailProposals: async () => response([proposal()]) },
    { deal: '20000000-0000-4000-8000-000000000002' });
  await view.refresh();
  assert.match(container.textContent, /Some email follow-ups could not be shown/);
  assert.equal(container.querySelectorAll('article').length, 0);
  assert.doesNotMatch(container.textContent, /No email follow-ups/);
  assert.doesNotMatch(container.textContent, /No pending/);
});

for (const decision of ['confirm']) test(`reopening a deal recovers the original uncertain ${decision} request`, async () => {
  const row = proposal(), writes = [];
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    const { name, arguments: args } = JSON.parse(init.body).params;
    let result;
    if (name === 'list-email-proposals') result = response([row]);
    else if (name === 'preview-email-next-step') result = row.preview;
    else {
      writes.push(args);
      if (writes.length === 1) throw Error('lost response');
      result = { ...row.preview, proposal_digest: args.proposal_digest, status: 'confirmed', requires_confirmation: false };
    }
    return Response.json({ result: { content: [{ text: JSON.stringify(result) }] } });
  } });
  async function decide(view) {
    await view.action('Confirm');
    await view.action('Confirm change');
  }
  const first = setup(client, { deal: row.deal });
  await first.view.refresh(); await decide(first, 'Original synthetic reason');
  assert.match(first.container.textContent, /Outcome unknown/);
  first.view.dispose();
  row.preview.proposal_digest = `sha256:${'b'.repeat(64)}`;
  const reopened = setup(client, { deal: row.deal });
  await reopened.view.refresh(); await decide(reopened, 'Changed synthetic reason');
  await reopened.action('Check outcome');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
  assert.match(reopened.container.textContent, decision === 'dismiss' ? /Dismissed\./ : /Confirmed\./);
});

const replyDraft = () => ({ ...proposal(), kind: 'reply_draft', confirm_verb: 'submit-email-draft', preview: null,
  reply_draft: { subject: 'Re: Demo floor plan', body: 'Thank you for the plan.', owner: 'joe', to: ['demo-correspondent@example.test'], cc: ['demo-partner@example.test'] } });

test('Home renders a contact reply draft beside a deal draft with its sender and owner', async () => {
  const contact = { ...replyDraft(), id: 'contact-draft', deal: null, deal_name: null };
  contact.source.sender = 'Dana Demo';
  const { container, view } = setup({ listEmailProposals: async () => response([replyDraft(), contact]) });
  await view.refresh();
  assert.equal(container.querySelectorAll('article').length, 2, container.textContent);
  const card = container.querySelector('[data-email-id="contact-draft"]');
  assert.match(card.textContent, /Dana Demo/);
  assert.match(card.textContent, /Reply draft · Re: Demo floor plan · Joe/);
  assert.equal(card.querySelector('a[href^="/deals"]'), null);
  assert.ok(card.querySelector('[data-email-action="edit-draft"]'));
  assert.doesNotMatch(container.textContent, /Could not load/);
});

test('an invalid reply draft cannot hide a valid draft or expose review controls', async () => {
  const invalid = { ...replyDraft(), id: 'invalid-draft', deal: null, deal_name: null };
  invalid.reply_draft.to = [];
  const { container, view } = setup({ listEmailProposals: async () => response([invalid, replyDraft()]) });
  await view.refresh();
  assert.equal(container.querySelectorAll('article').length, 1, container.textContent);
  assert.equal(container.querySelector('[data-email-id="invalid-draft"]'), null);
  assert.ok(container.querySelector('[data-email-action="edit-draft"]'));
  assert.match(container.textContent, /Some email follow-ups could not be shown/);
});
const draftReceipt = args => ({ ok: true, proposal_id: args.proposal_id, version: args.base_version + 1,
  status: 'approved_to_send', subject: args.subject, body: args.body, sha256: 'a'.repeat(64),
  to: ['demo-correspondent@example.test'], cc: ['demo-partner@example.test'] });
function editDraft(dom, container, field, value) {
  const input = container.querySelector(`[data-email-${field}]`);
  assert.ok(input, `${field} editor is visible`);
  input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

test('Home opens a reply draft for editing and Submit queues the exact reviewed text and version', async () => {
  const row = replyDraft(), calls = [];
  const { dom, container, view, action, send } = setup({ listEmailProposals: async () => response([row]),
    submitEmailDraft: async args => { calls.push(args); return draftReceipt(args); } });
  await view.refresh();
  assert.match(container.textContent, /Reply draft/);
  await action('Review reply');
  assert.match(container.textContent, /To: demo-correspondent@example.test/);
  assert.match(container.textContent, /CC: demo-partner@example.test/);
  assert.equal(calls.length, 0, 'opening a review never submits');
  editDraft(dom, container, 'subject', 'Re: Demo plan reviewed');
  editDraft(dom, container, 'body', '  I reviewed the plan.\nPlease send the dimensions.  ');
  await send();
  const { idempotency_key, ...sent } = calls[0];
  assert.ok(idempotency_key);
  assert.deepEqual(sent, { proposal_id: row.id, base_version: 3, subject: 'Re: Demo plan reviewed',
    body: '  I reviewed the plan.\nPlease send the dimensions.  ', to: ['demo-correspondent@example.test'], cc: ['demo-partner@example.test'] });
  assert.match(container.textContent, /Submitted for sending/);
  assert.match(container.textContent, /To: demo-correspondent@example.test/);
  assert.match(container.textContent, /CC: demo-partner@example.test/);
  assert.equal(container.querySelector('[data-email-action="submit-draft"]'), null);
});

test('Submit opens a 10 second send grace and Undo returns the edited draft without any server call', async () => {
  const calls = [];
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async args => { calls.push(args); return draftReceipt(args); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Edited before the grace.');
  await action('Submit');
  assert.match(container.textContent, /Sending in 10s · Undo/);
  mock.timers.tick(1000);
  assert.match(container.textContent, /Sending in 9s · Undo/);
  mock.timers.tick(8000);
  assert.match(container.textContent, /Sending in 1s · Undo/);
  await action('Undo'); await settle();
  mock.timers.tick(60_000); await settle();
  assert.equal(calls.length, 0, 'Undo within the grace never reaches the server');
  assert.equal(container.querySelector('[data-email-body]').value, 'Edited before the grace.');
  assert.ok(container.querySelector('[data-email-action="submit-draft"]'));
  assert.doesNotMatch(container.textContent, /Sending in/);
});

test('the send grace expiring submits exactly once with the key minted at Submit', async () => {
  const calls = [];
  const { container, view, action } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async args => { calls.push(args); return draftReceipt(args); } });
  await view.refresh(); await action('Review reply'); await action('Submit');
  mock.timers.tick(9999); await settle();
  assert.equal(calls.length, 0, 'nothing is submitted before the grace ends');
  mock.timers.tick(1); await settle();
  assert.equal(calls.length, 1);
  await action('Undo'); await view.refresh();
  mock.timers.tick(60_000); await settle();
  assert.equal(calls.length, 1, 'the grace never submits twice');
  assert.ok(calls[0].idempotency_key);
  assert.match(container.textContent, /Submitted for sending/);
});

for (const leave of ['pagehide', 'dispose']) test(`leaving the page during the send grace (${leave}) submits nothing and keeps the draft unsubmitted`, async () => {
  const calls = [];
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async args => { calls.push(args); return draftReceipt(args); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Not yet sent.');
  await action('Submit');
  if (leave === 'pagehide') dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  else view.dispose();
  mock.timers.tick(60_000); await settle();
  assert.equal(calls.length, 0);
  if (leave === 'pagehide') {
    assert.equal(container.querySelector('[data-email-body]').value, 'Not yet sent.');
    assert.doesNotMatch(container.textContent, /Sending in/);
  }
});

for (const leave of ['pagehide', 'session loss', 'dispose']) test(`leaving (${leave}) as the send grace expires, before the command starts, submits nothing`, async () => {
  const calls = [];
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async args => { calls.push(args); return draftReceipt(args); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Not yet sent.');
  await action('Submit');
  mock.timers.tick(10_000);
  if (leave === 'pagehide') dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  else if (leave === 'session loss') dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  else view.dispose();
  await settle();
  assert.equal(calls.length, 0);
  if (leave === 'pagehide') {
    assert.equal(container.querySelector('[data-email-body]').value, 'Not yet sent.');
    assert.doesNotMatch(container.textContent, /Sending in|Submitted for sending/);
  }
});

test('a refusal after the send grace is shown plainly with the edits kept', async () => {
  const { dom, container, view, action, send } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async () => { throw Object.assign(Error('submitted'), { payload: { error: 'email_draft_already_submitted' } }); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Refused text stays.');
  await send();
  assert.match(container.textContent, /This reply has already been submitted\. Refresh to review the current state\./);
  assert.equal(container.querySelector('[data-email-body]').value, 'Refused text stays.');
  assert.doesNotMatch(container.textContent, /Sending in|Submitted for sending/);
});

test('Undo edit restores the draft as it was before the last edit, one step only', async () => {
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([replyDraft()]) });
  await view.refresh(); await action('Review reply');
  const undo = () => container.querySelector('[data-email-action="undo-edit"]');
  assert.equal(undo().disabled, true, 'nothing to undo before an edit');
  editDraft(dom, container, 'body', 'First edit.');
  container.querySelector('[data-email-body]').dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
  editDraft(dom, container, 'body', 'Second edit');
  editDraft(dom, container, 'body', 'Second edit, still typing.');
  assert.equal(undo().disabled, false);
  await action('Undo edit');
  assert.equal(container.querySelector('[data-email-body]').value, 'First edit.');
  assert.equal(container.querySelector('[data-email-subject]').value, 'Re: Demo floor plan');
  assert.equal(undo().disabled, true, 'undo is one step');
  editDraft(dom, container, 'subject', 'Re: New subject');
  await action('Undo edit');
  assert.equal(container.querySelector('[data-email-subject]').value, 'Re: Demo floor plan');
  assert.equal(container.querySelector('[data-email-body]').value, 'First edit.');
});

test('reply edits survive refresh and version refusal without adopting a newer version', async () => {
  const row = replyDraft(), calls = [];
  const { dom, container, view, action, send } = setup({ listEmailProposals: async () => response([row]),
    submitEmailDraft: async args => { calls.push(args); throw Object.assign(Error('stale'), { payload: { error: 'version_conflict' } }); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'My unsent reply.');
  row.version = 4; row.reply_draft.body = 'A newer stored draft.';
  await view.refresh();
  assert.equal(container.querySelector('[data-email-body]').value, 'My unsent reply.');
  await send();
  assert.equal(calls[0].base_version, 3);
  assert.equal(container.querySelector('[data-email-body]').value, 'My unsent reply.');
  assert.match(container.textContent, /changed.*Refresh and review/);
});

test('reply submission loss locks editing and Check outcome replays the exact request after removal from the list', async () => {
  const row = replyDraft(), calls = []; let listed = [row];
  const { dom, container, view, action, send } = setup({ listEmailProposals: async () => response(listed),
    submitEmailDraft: async args => { calls.push(args); if (calls.length === 1) { listed = []; throw Error('lost response'); } return draftReceipt(args); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Only send this once.');
  await send(); await view.refresh();
  assert.match(container.textContent, /Outcome unknown/);
  assert.equal(container.querySelector('[data-email-body]'), null);
  await action('Check outcome');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.match(container.textContent, /Submitted for sending/);
});

test('reply review cancels without writing, rejects empty text and clears private edits on identity loss', async () => {
  let writes = 0;
  const { dom, container, view, action, send } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async () => { writes++; } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', '   ');
  await action('Submit');
  assert.equal(writes, 0);
  assert.match(container.textContent, /Enter a subject/);
  await action('Cancel');
  assert.equal(container.querySelector('[data-email-body]'), null);
  await action('Review reply'); editDraft(dom, container, 'body', 'Private synthetic edit.');
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  assert.doesNotMatch(container.textContent, /Private synthetic|floor plan/);
  assert.match(container.textContent, /Sign in/);
  assert.equal(writes, 0);
});

test('a reply receipt for different text is uncertain rather than claiming success', async () => {
  const { container, view, action, send } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async args => ({ ...draftReceipt(args), body: 'Wrong text' }) });
  await view.refresh(); await action('Review reply'); await send();
  assert.match(container.textContent, /Outcome unknown/);
  assert.doesNotMatch(container.textContent, /Submitted for sending/);
});

for (const [label, malformed] of [
  ['different to', { to: ['different@example.test'] }], ['different cc', { cc: ['different@example.test'] }],
  ['empty cc', { cc: [] }], ['invalid to', { to: ['missing-at.example.test'] }], ['invalid cc', { cc: ['bad address@example.test'] }],
  ['version', { version: 99 }], ['proposal_id', { proposal_id: 'different-proposal' }], ['sha256', { sha256: 'invalid' }],
]) test(`reply submission never claims success for a malformed ${label} receipt`, async () => {
  const { container, view, action, send } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async args => ({ ...draftReceipt(args), ...malformed }) });
  await view.refresh(); await action('Review reply'); await send();
  assert.match(container.textContent, /Outcome unknown/);
  assert.doesNotMatch(container.textContent, /Submitted for sending/);
});

test('reply CC-address refusal keeps the edited text available for the owning partner', async () => {
  const { dom, container, view, action, send } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async () => { throw Object.assign(Error('missing copy'), { payload: { error: 'email_draft_copy_address_missing' } }); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Preserve my exact edits.');
  await send();
  assert.equal(container.querySelector('[data-email-body]').value, 'Preserve my exact edits.');
  assert.match(container.textContent, /other partner needs an email address/);
  assert.doesNotMatch(container.textContent, /Submitted for sending/);
});

test('a reply version conflict requires explicit fresh review while preserving partner edits', async () => {
  const row = replyDraft(), calls = []; let conflict = true;
  const { dom, container, view, action, send } = setup({ listEmailProposals: async () => response([row]),
    submitEmailDraft: async args => { calls.push(args); if (conflict) throw Object.assign(Error('conflict'), { payload: { error: 'version_conflict' } }); return draftReceipt(args); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'My revised reply must survive.');
  row.version = 4; row.reply_draft.body = 'Updated saved original.';
  await send();
  assert.ok([...container.querySelectorAll('button')].some(button => button.textContent === 'Review updated draft'));
  await view.refresh();
  assert.equal(calls.length, 1, 'background refresh never resubmits');
  assert.equal(container.querySelector('[data-email-body]').value, 'My revised reply must survive.');
  await action('Review updated draft');
  assert.match(container.textContent, /Updated saved original\./);
  assert.equal(calls.length, 1, 'fresh review never submits');
  conflict = false;
  await send();
  assert.equal(calls[1].base_version, 4);
  assert.equal(calls[1].body, 'My revised reply must survive.');
  assert.notEqual(calls[0].idempotency_key, calls[1].idempotency_key);
  assert.match(container.textContent, /Submitted for sending/);
});

for (const actor of ['joe', 'dell', null]) test(`reply review is offered only to its owner when signed in as ${actor}`, async () => {
  const { container, view } = setup({ selfActor: actor, listEmailProposals: async () => response([replyDraft()]) });
  await view.refresh();
  assert.equal(Boolean(container.querySelector('[data-email-action="edit-draft"]')), actor === 'joe');
  assert.equal(Boolean(container.querySelector('[data-followup="defer"]')), actor === 'joe');
});

test('recipient changes preserve reviewed addresses across refresh and require explicit fresh review after refusal', async () => {
  const row = replyDraft(), calls = []; let changed = true;
  const { container, view, action, send } = setup({ listEmailProposals: async () => response([row]),
    submitEmailDraft: async args => { calls.push(args); if (changed) throw Object.assign(Error('changed'), { payload: { error: 'email_draft_recipients_mismatch' } }); return { ...draftReceipt(args), to: args.to, cc: args.cc }; } });
  await view.refresh(); await action('Review reply');
  row.reply_draft.to[0] = 'updated-sender@example.test';
  row.reply_draft.cc = ['updated-partner@example.test'];
  await view.refresh();
  assert.match(container.textContent, /To: demo-correspondent@example.test/);
  assert.doesNotMatch(container.textContent, /updated-sender/);
  await send();
  assert.deepEqual(calls[0].to, ['demo-correspondent@example.test']);
  assert.deepEqual(calls[0].cc, ['demo-partner@example.test']);
  assert.match(container.textContent, /Recipients changed/);
  assert.equal(container.querySelector('[data-email-action="submit-draft"]'), null);
  await action('Review updated draft');
  assert.match(container.textContent, /To: updated-sender@example.test/);
  assert.match(container.textContent, /CC: updated-partner@example.test/);
  assert.equal(calls.length, 1);
  changed = false;
  await send();
  assert.deepEqual(calls[1].to, ['updated-sender@example.test']);
  assert.deepEqual(calls[1].cc, ['updated-partner@example.test']);
  assert.match(container.textContent, /Submitted for sending/);
});

for (const recipients of [{ to: [] }, { cc: [] }, { to: ['bad address'] }]) test(`invalid reply recipients prevent review ${JSON.stringify(recipients)}`, async () => {
  const row = replyDraft(); Object.assign(row.reply_draft, recipients);
  const { container, view } = setup({ listEmailProposals: async () => response([row]) });
  await view.refresh();
  assert.match(container.textContent, /Some email follow-ups could not be shown/);
  assert.equal(container.querySelector('[data-email-action="edit-draft"]'), null);
});

test('reply ownership updates when authenticated identity arrives after the independent email read', async () => {
  const client = { selfActor: null, listEmailProposals: async () => response([replyDraft()]) };
  const { container, view } = setup(client, { client });
  await view.refresh();
  assert.equal(container.querySelector('[data-email-action="edit-draft"]'), null);
  client.selfActor = 'joe';
  view.update();
  assert.ok(container.querySelector('[data-email-action="edit-draft"]'));
});

for (const code of ['email_draft_copy_address_missing', 'email_draft_source_missing']) test(`a reply without resolved recipients stays readable and dismissible beside other proposals ${code}`, async () => {
  const row = { ...replyDraft(), deal: null, deal_name: null }; delete row.reply_draft.to; delete row.reply_draft.cc;
  row.confirm_verb = null; row.preview_error = code;
  const { container, view } = setup({ listEmailProposals: async () => response([row, { ...proposal(), id: 'another-proposal' }]) });
  await view.refresh();
  assert.equal(container.querySelectorAll('article').length, 2);
  assert.match(container.textContent, /Recipient addresses are unavailable/);
  assert.equal(container.querySelector('[data-email-action="edit-draft"]'), null);
  assert.equal(container.querySelectorAll('[data-followup="defer"]').length, 2);
  assert.doesNotMatch(container.textContent, /Could not load/);
});

test('Home caps email cards and exposes deferred actions directly', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...proposal(), id: `demo-${i}` }));
  const { container, view, action } = setup({ listEmailProposals: async () => response(rows) });
  const pending = view.refresh();
  assert.ok(container.querySelector('.home-followup-skeleton'));
  await pending;
  assert.equal(container.querySelectorAll('article').length, 2);
  assert.match(container.textContent, /Showing 2 of 5/);
  assert.equal(container.querySelectorAll('details.email-dismiss').length, 0);
  assert.equal(container.querySelectorAll('[data-followup="defer"]').length, 2);

  await action('Show 3 more');
  assert.equal(container.querySelectorAll('article').length, 5);
  view.dispose();
});

test('email refresh keeps the loaded cards without inserting a loading skeleton', async () => {
  let release, next = response([proposal()]);
  const { container, view } = setup({ listEmailProposals: async () => next });
  await view.refresh();
  next = new Promise(resolve => { release = resolve; });
  const pending = view.refresh();
  assert.equal(container.querySelectorAll('article').length, 1);
  assert.equal(container.querySelector('.home-followup-skeleton'), null);
  release(response([proposal()]));
  await pending;
  view.dispose();
});

for (const subjectType of ['client','lead','vendor']) test(`Home reviews ${subjectType} next steps without requiring a deal`, async () => {
  const row = proposal();
  Object.assign(row, { deal: null, deal_name: null, subject_type: subjectType,
    subject_id: '40000000-0000-4000-8000-000000000001', subject_name: 'Demo contact' });
  Object.assign(row.preview, { deal: null, deal_name: null, subject_type: row.subject_type,
    subject_id: row.subject_id, subject_name: row.subject_name });
  const calls = [];
  const { container, view, action } = setup({
    listEmailProposals: async args => { calls.push(['list',args]); return response([row]); },
    previewEmailNextStep: async args => { calls.push(['preview',args]); return row.preview; },
    confirmEmailNextStep: async args => { calls.push(['confirm',args]); return { ...row.preview, status: 'confirmed', requires_confirmation: false }; },
  });
  await view.refresh();
  assert.match(container.textContent, /Demo contact/);
  assert.doesNotMatch(container.textContent, /Possible new deal|Could not load/);
  assert.equal(calls[0][1].include_non_deal, true);
  await action('Confirm');
  assert.match(container.textContent, new RegExp(`change to the ${subjectType}`));
  assert.match(container.textContent, /Call the landlord/);
  await action('Confirm change');
  assert.equal(calls.at(-1)[1].deal, null);
  assert.equal(calls.at(-1)[1].activity_id, row.source.activity_id);
  assert.equal(calls.at(-1)[1].proposal_digest, digest);
  assert.match(container.textContent, /Confirmed/);
});

test('a non-deal preview for a different contact is rejected before offering confirmation', async () => {
  const row = proposal();
  Object.assign(row, { deal: null, deal_name: null, subject_type: 'vendor', subject_id: 'vendor-one', subject_name: 'Demo vendor' });
  Object.assign(row.preview, { deal: null, subject_type: 'vendor', subject_id: 'vendor-two', subject_name: 'Demo vendor' });
  const { container, view } = setup({ listEmailProposals: async () => response([row]) });
  await view.refresh();
  assert.match(container.textContent, /Some email follow-ups could not be shown/);
  assert.equal(container.querySelector('[data-email-action="preview"]'), null);
});

test('draft save updates the current card when a refresh replaced its row during the write', async () => {
  const row = replyDraft(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([structuredClone(row)]),
    editEmailDraft: async args => { entered(); await pending; return { ok: true, proposal_id: args.proposal_id, version: 4, subject: args.subject, body: args.body }; } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Demo saved during refresh');
  const saving = action('Save draft'); await started;
  await view.refresh(); release(); await saving;
  await action('Cancel'); await action('Review reply');
  assert.equal(container.querySelector('[data-email-body]').value, 'Demo saved during refresh');
});

for (const [code, message] of Object.entries({
  email_draft_not_found: /no longer available/,
  email_draft_not_owner: /Only the partner/,
  email_draft_not_pending: /no longer a pending draft/,
  email_draft_empty_body: /Enter a message/,
  email_draft_subject_invalid: /Enter a subject without line breaks/,
  invalid_field_value: /at most 998 characters.*20,000 characters/,
  key_reuse: /already used for different text/,
  offline: /offline.*Reconnect/,
  unexpected_refusal: /could not be saved.*Reload/,
})) test(`draft save explains ${code} without claiming success or sending`, async () => {
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([replyDraft()]),
    editEmailDraft: async () => { throw Object.assign(Error('synthetic refusal'), { payload: { error: code } }); },
    submitEmailDraft: async () => { assert.fail('save must never submit'); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Demo unsent edit');
  await action('Save draft');
  assert.match(container.textContent, message);
  assert.doesNotMatch(container.textContent, /Saved as a draft/);
  assert.equal(container.querySelector('[data-email-body]').value, 'Demo unsent edit');
});

test('uncertain draft save locks edits and Check outcome replays only the original save', async () => {
  const calls = [];
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([replyDraft()]),
    editEmailDraft: async args => { calls.push(args); if (calls.length === 1) throw Error('lost response'); return { ok: true, proposal_id: args.proposal_id, version: 4, subject: args.subject, body: args.body }; },
    submitEmailDraft: async () => { assert.fail('save must never submit'); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Demo original save'); await action('Save draft');
  assert.match(container.textContent, /Outcome unknown/);
  assert.equal(container.querySelector('[data-email-body]'), null);
  await action('Check outcome');
  assert.deepEqual(calls[1], calls[0]);
  assert.match(container.textContent, /Saved as a draft. Nothing was sent/);
  editDraft(dom, container, 'body', 'Demo new unsaved text');
  assert.doesNotMatch(container.textContent, /Saved as a draft/);
});

for (const actor of ['joe', 'dell']) test(`${actor} saves and submits a contact reply with exact source-bound recipients`, async () => {
  const row = { ...replyDraft(), deal: null, deal_name: null };
  row.reply_draft.owner = actor;
  const calls = [];
  const { dom, container, view, action, send } = setup({ selfActor: actor,
    listEmailProposals: async () => response([row]),
    editEmailDraft: async args => { calls.push(['edit', args]); return { ok: true, proposal_id: row.id, version: 4, subject: args.subject, body: args.body }; },
    submitEmailDraft: async args => { calls.push(['submit', args]); return draftReceipt(args); },
  });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Demo saved contact reply');
  await action('Save draft');
  assert.match(container.textContent, /Saved as a draft/);
  assert.equal(calls.length, 1);
  await send();
  assert.equal(calls[1][0], 'submit');
  assert.equal(calls[1][1].proposal_id, row.id);
  assert.equal(calls[1][1].base_version, 4);
  assert.equal(calls[1][1].body, 'Demo saved contact reply');
  assert.deepEqual(calls[1][1].to, row.reply_draft.to);
  assert.deepEqual(calls[1][1].cc, row.reply_draft.cc);
  assert.equal(Object.hasOwn(calls[1][1], 'deal'), false);
  assert.match(container.textContent, /Submitted for sending/);
});



for (const invalid of [{ source: null }, { source: { evidence_quote: 'Demo' } }, { reply_draft: null },
  { reply_draft: { ...replyDraft().reply_draft, owner: 'unknown' } },
  { reply_draft: { ...replyDraft().reply_draft, to: [] } },
  { reply_draft: { ...replyDraft().reply_draft, cc: ['bad address'] } },
  { kind: 'phase_move', confirm_verb: 'confirm-email-deal-progress' },
]) test(`invalid contact proposal is omitted without hiding a valid reply ${JSON.stringify(invalid)}`, async () => {
  const row = { ...replyDraft(), deal: null, deal_name: null, ...invalid };
  const valid = { ...replyDraft(), id: 'valid-draft' };
  const { container, view } = setup({ listEmailProposals: async () => response([row, valid]) });
  await view.refresh();
  assert.equal(container.querySelectorAll('article').length, 1);
  assert.equal(container.querySelector('article').dataset.emailId, valid.id);
  assert.match(container.textContent, /Some email follow-ups could not be shown/);
});

test('a rejected row on a paged read keeps valid pages and clears after a full refresh', async () => {
  const first = replyDraft(), second = { ...replyDraft(), id: 'second-draft', deal: null, deal_name: null };
  const invalid = { ...replyDraft(), id: 'invalid-draft', source: null };
  let broken = true;
  const { container, view, action } = setup({ listEmailProposals: async args => args.cursor
    ? response(broken ? [invalid, second] : [second]) : { ...response([first]), more: true, next_cursor: first.id } });
  await view.refresh(); await action('Load more email follow-ups');
  assert.equal(container.querySelectorAll('article').length, 2);
  assert.match(container.textContent, /Some email follow-ups could not be shown/);
  broken = false; await action('Refresh email follow-ups');
  assert.equal(container.querySelectorAll('article').length, 2);
  assert.doesNotMatch(container.textContent, /Some email follow-ups could not be shown/);
});

const clickFollowup = async (container, label) => {
  const control = [...container.querySelectorAll('button')].find(node => node.textContent === label);
  assert.ok(control, label); control.click(); await settle();
};
const fillFollowup = (container, key, value) => {
  const field = container.querySelector(`[data-field="${key}"]`); assert.ok(field, key);
  field.value = value; field.dispatchEvent(new field.ownerDocument.defaultView.Event('input', { bubbles: true }));
};
const filingRow = () => ({ ...proposal(), kind: 'file_to_deal', confirm_verb: 'confirm-email-filing',
  suggested_deals: [{ deal: proposal().deal, name: 'Demo Harbor expansion', reasons: ['Existing client transaction'] }],
  preview: { contract: 'email-filing.v1', proposal_id: proposal().id, kind: 'file_to_deal', deal: proposal().deal,
    activity_id: proposal().source.activity_id, evidence_quote: proposal().source.evidence_quote, sender: { party_id: 'demo-person' }, new_people: [], proposal_digest: digest, requires_confirmation: true } });

for (const kind of ['file_to_deal', 'possible_new_deal']) test(`${kind} files to the exact selected existing deal with note and no creation`, async () => {
  const row = filingRow(); row.kind = kind; row.preview.kind = kind;
  if (kind === 'possible_new_deal') { row.deal = null; row.deal_name = null; row.preview.deal = null; }
  const calls = [], previews = [];
  const { container, view } = setup({ listEmailProposals: async () => response([row]),
    getBoard: async () => ({ deals: [{ id: proposal().deal, name: 'Demo Harbor expansion' }] }),
    previewEmailFiling: async args => { previews.push(args); return { ...row.preview, contract: 'email-followups.v2', deal: args.deal, base_version: row.version }; },
    createDeal: async () => assert.fail('existing deal must not create'),
    confirmEmailFiling: async args => { calls.push(args); return { ok: true, proposal_id: row.id, version: 4, status: 'confirmed', disposition: 'filed', note: args.note, deal: args.deal, activity_id: row.source.activity_id }; } });
  await view.refresh(); await clickFollowup(container, 'File to existing deal');
  fillFollowup(container, 'deal', proposal().deal); fillFollowup(container, 'note', 'Discussed on the call');
  await clickFollowup(container, 'Review selected deal');
  assert.equal(calls.length, 0); assert.equal(previews.length, 1);
  await clickFollowup(container, 'Confirm filing');
  assert.equal(calls.length, 1); assert.equal(calls[0].deal, proposal().deal); assert.equal(calls[0].note, 'Discussed on the call');
  assert.equal(calls[0].proposal_digest, digest); assert.equal(calls[0].disposition, 'filed');
  assert.equal(Object.hasOwn(previews[0], 'correction_reason'), false);
  assert.equal(Object.hasOwn(calls[0], 'correction_reason'), false);
});

test('Central default and explicit picker reject DST gaps and folds', async () => {
  const { tomorrowCentral, centralInstant } = await import('../js/ui-email-actions.generated.js');
  assert.equal(tomorrowCentral(new Date('2026-03-07T23:00:00Z')), '2026-03-08T09:00');
  assert.equal(centralInstant('2026-03-08T09:00'), '2026-03-08T14:00:00.000Z');
  assert.equal(tomorrowCentral(new Date('2026-10-31T23:00:00Z')), '2026-11-01T09:00');
  assert.equal(centralInstant('2026-11-01T09:00'), '2026-11-01T15:00:00.000Z');
  assert.throws(() => centralInstant('2026-03-08T02:30'));
  assert.throws(() => centralInstant('2026-11-01T01:30'));
});

test('Not now retains notes and reviewed version across refresh and replays an uncertain request exactly', async () => {
  let row = proposal(); const calls = [];
  const { container, view, dom } = setup({ listEmailProposals: async () => response([structuredClone(row)]),
    snoozeEmailProposal: async args => { calls.push(args); if (calls.length === 1) throw Error('lost'); return { ok: true, proposal_id: row.id, status: 'pending', version: 4, disposition: 'deferred', note: args.note, deferred_until: args.deferred_until }; } });
  await view.refresh(); await clickFollowup(container, 'Not now');
  fillFollowup(container, 'when', '2099-11-04T09:00'); fillFollowup(container, 'note', 'Call after review');
  const field = container.querySelector('textarea'); field.focus();
  row.version = 4; await view.refresh();
  assert.equal(dom.window.document.activeElement, field);
  assert.equal(field.value, 'Call after review');
  await clickFollowup(container, 'Defer follow-up');
  assert.equal(calls[0].base_version, 3); assert.equal(calls[0].deferred_until, '2099-11-04T15:00:00.000Z');
  await clickFollowup(container, 'Check outcome');
  assert.deepEqual(calls[0], calls[1]); assert.match(container.textContent, /Returns .*America\/Chicago/);
});

test('handled filing requires a deal, Cancel writes nothing and stale refusals require explicit review', async () => {
  const row = filingRow(); row.kind = 'possible_new_deal'; row.deal = null; row.deal_name = null; row.preview.kind = row.kind; row.preview.deal = null;
  const writes = [];
  const { container, view } = setup({ listEmailProposals: async () => response([row]), getBoard: async () => ({ deals: [] }),
    previewEmailFiling: async args => ({ ...row.preview, contract: 'email-followups.v2', deal: args.deal, base_version: 3 }),
    confirmEmailFiling: async args => { writes.push(args); throw Object.assign(Error('stale'), { payload: { error: 'version_conflict' } }); } });
  await view.refresh(); await clickFollowup(container, 'Already handled'); await clickFollowup(container, 'Review selected deal');
  assert.match(container.textContent, /Choose the deal/); assert.equal(writes.length, 0);
  await clickFollowup(container, 'Cancel'); assert.equal(writes.length, 0);
  await clickFollowup(container, 'New deal'); fillFollowup(container, 'note', 'Do not save'); await clickFollowup(container, 'Cancel');
  assert.equal(writes.length, 0);
});

for (const kind of ['file_to_deal', 'possible_new_deal']) test(`${kind} recovers one uncertain new deal and previews its exact target`, async () => {
  const row = filingRow(); row.kind = kind; row.preview.kind = kind;
  const creates = [], writes = [], previews = [];
  let failPreview = true;
  const { container, view } = setup({ listEmailProposals: async () => response([row]),
    createDeal: async args => { creates.push(args); if (creates.length === 1) throw Error('lost creation receipt'); return { deal_id: 'new-demo-deal' }; },
    previewEmailFiling: async args => { previews.push(args); if (failPreview) throw Error('unavailable'); return { ...row.preview, contract: 'email-followups.v2', deal: args.deal, base_version: 3 }; },
    confirmEmailFiling: async args => { writes.push(args); return { ok: true, proposal_id: row.id, status: 'confirmed', version: 4, disposition: 'filed', note: args.note, deal: args.deal, activity_id: row.source.activity_id }; } });
  await view.refresh(); await clickFollowup(container, 'New deal');
  fillFollowup(container, 'name', 'Separate demo transaction'); fillFollowup(container, 'client', 'Demo existing client'); fillFollowup(container, 'note', 'Separate transaction confirmed');
  await clickFollowup(container, 'Create deal and review filing');
  assert.match(container.textContent, /Outcome unknown/);
  await view.refresh(); await clickFollowup(container, 'Check outcome');
  assert.deepEqual(creates[0], creates[1]);
  assert.match(container.textContent, /Deal created. Filing was not confirmed/);
  assert.equal(container.querySelector('a').getAttribute('href').startsWith('/deals'), true);
  failPreview = false; await clickFollowup(container, 'Review created deal'); await clickFollowup(container, 'Confirm filing');
  assert.equal(creates.length, 2); assert.equal(writes.length, 1); assert.equal(writes[0].deal, 'new-demo-deal');
  assert.equal(writes[0].note, 'Separate transaction confirmed'); assert.equal(previews.length, 2);
});

for (const kind of ['next_step', 'reply_draft']) test(`${kind} handled stores the note without filing or sending`, async () => {
  const row = kind === 'reply_draft' ? replyDraft() : proposal();
  const calls = [];
  const { container, view } = setup({ listEmailProposals: async () => response([row]),
    handleEmailProposal: async args => { calls.push(args); return { ok: true, proposal_id: row.id, status: 'confirmed', disposition: 'handled', version: row.version + 1, note: args.note }; },
    createDeal: async () => assert.fail('handled must not create'), confirmEmailFiling: async () => assert.fail('handled must not file'), submitEmailDraft: async () => assert.fail('handled must not send') });
  await view.refresh(); await clickFollowup(container, 'Already handled'); fillFollowup(container, 'note', 'Discussed by phone'); await clickFollowup(container, 'Confirm handled');
  assert.equal(calls.length, 1); assert.equal(calls[0].note, 'Discussed by phone');
});

for (const mismatch of ['proposal_id', 'deal', 'activity_id', 'note', 'version']) test(`filing keeps an unconfirmed ${mismatch} receipt uncertain and replays the same request`, async () => {
  const row = filingRow(), calls = [];
  const { container, view } = setup({ listEmailProposals: async () => response([row]), getBoard: async () => ({ deals: [] }),
    previewEmailFiling: async args => ({ ...row.preview, contract: 'email-followups.v2', deal: args.deal, base_version: 3 }),
    confirmEmailFiling: async args => { calls.push(args); const result = { ok: true, proposal_id: row.id, status: 'confirmed', disposition: 'filed', version: 4, note: args.note, deal: args.deal, activity_id: row.source.activity_id }; return calls.length === 1 ? { ...result, [mismatch]: 'different' } : result; } });
  await view.refresh(); await clickFollowup(container, 'File to existing deal'); fillFollowup(container, 'note', 'Reviewed'); await clickFollowup(container, 'Review selected deal'); await clickFollowup(container, 'Confirm filing');
  assert.match(container.textContent, /Outcome unknown/); await clickFollowup(container, 'Check outcome'); assert.deepEqual(calls[0], calls[1]);
  assert.match(container.textContent, /Filed to the selected deal/);
});

test('a deferred card returns actionable when due in the same mounted Home', async () => {
  const row = proposal(); let deferred = false;
  const { container, view } = setup({ listEmailProposals: async () => response(deferred ? [] : [row]),
    snoozeEmailProposal: async args => { deferred = true; row.version++; return { ok: true, proposal_id: row.id, status: 'pending', disposition: 'deferred', version: 4, note: args.note, deferred_until: args.deferred_until }; } });
  await view.refresh(); await clickFollowup(container, 'Not now'); fillFollowup(container, 'when', '2099-01-01T09:00'); await clickFollowup(container, 'Defer follow-up');
  assert.equal(container.querySelector('article'), null);
  deferred = false; await view.refresh();
  assert.ok([...container.querySelectorAll('button')].find(node => node.textContent === 'Not now'));
});

test('an uncertain deferral stays visible after refresh and locks competing reply submission', async () => {
  const row = replyDraft(); let hidden = false;
  const { container, view } = setup({ listEmailProposals: async () => response(hidden ? [] : [row]),
    snoozeEmailProposal: async () => { hidden = true; throw Error('lost receipt'); }, submitEmailDraft: async () => assert.fail('uncertain deferral must lock sending') });
  await view.refresh(); await clickFollowup(container, 'Not now'); fillFollowup(container, 'when', '2099-01-01T09:00'); await clickFollowup(container, 'Defer follow-up');
  assert.equal(container.querySelector('[data-email-action="edit-draft"]').disabled, true);
  await view.refresh(); assert.match(container.textContent, /Outcome unknown/);
  assert.ok([...container.querySelectorAll('button')].find(node => node.textContent === 'Check outcome'));
});

test('cancelling or refusing filing after creation retains the created deal instead of offering another creation', async () => {
  const row = filingRow(); let creates = 0, refuse = false;
  const { container, view } = setup({ listEmailProposals: async () => response([row]),
    createDeal: async () => { creates++; return { deal_id: 'created-demo' }; },
    previewEmailFiling: async args => ({ ...row.preview, contract: 'email-followups.v2', deal: args.deal, base_version: 3 }),
    confirmEmailFiling: async () => { refuse = true; throw Object.assign(Error('stale'), { payload: { error: 'version_conflict' } }); } });
  await view.refresh(); await clickFollowup(container, 'New deal'); fillFollowup(container, 'name', 'Separate demo transaction'); fillFollowup(container, 'client', 'Demo Client'); await clickFollowup(container, 'Create deal and review filing');
  await clickFollowup(container, 'Cancel');
  assert.equal([...container.querySelectorAll('button')].some(node => node.textContent === 'New deal'), false);
  await clickFollowup(container, 'Review created deal'); await clickFollowup(container, 'Confirm filing');
  assert.equal(refuse, true); assert.equal(creates, 1);
  assert.equal([...container.querySelectorAll('button')].some(node => node.textContent === 'New deal'), false);
  assert.match(container.textContent, /created.*version_conflict/i);
});

test('a refusal after uncertain creation never discards the original creation request', async () => {
  const row = filingRow(), calls = [];
  const { container, view } = setup({ listEmailProposals: async () => response([row]),
    createDeal: async args => { calls.push(args); if (calls.length === 1) throw Error('lost'); throw Object.assign(Error('refused after uncertainty'), { payload: { error: 'version_conflict' } }); } });
  await view.refresh(); await clickFollowup(container, 'New deal'); fillFollowup(container, 'name', 'Separate demo'); fillFollowup(container, 'client', 'Demo Client'); await clickFollowup(container, 'Create deal and review filing');
  await clickFollowup(container, 'Check outcome');
  assert.match(container.textContent, /Outcome unknown/); assert.deepEqual(calls[0], calls[1]);
  assert.equal([...container.querySelectorAll('button')].some(node => node.textContent === 'New deal'), false);
});

for (const action of ['defer', 'file', 'handled']) test(`remounted live ${action} recovers the original pending request and receipt`, async () => {
  const row = action === 'handled' ? proposal() : filingRow(), calls = [];
  const verb = { defer: 'snooze-email-proposal', file: 'confirm-email-filing', handled: 'handle-email-proposal' }[action];
  const client = createLiveClient({ selfActor: 'joe', fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    const { name, arguments: args } = JSON.parse(init.body).params;
    let result;
    if (name === 'list-email-proposals') result = response([row]);
    else if (name === 'deal-room-board') result = { deals: [] };
    else if (name === 'preview-email-filing') result = { ...row.preview, contract: 'email-followups.v2', deal: args.deal, base_version: row.version };
    else if (name === verb) {
      calls.push(args);
      if (calls.length === 1) throw Error('synthetic lost response');
      result = { ok: true, proposal_id: row.id, version: args.base_version + 1, note: args.note,
        status: action === 'defer' ? 'pending' : 'confirmed', disposition: action === 'defer' ? 'deferred' : action === 'file' ? 'filed' : 'handled',
        ...(action === 'defer' ? { deferred_until: args.deferred_until } : { deal: args.deal, activity_id: row.source.activity_id }) };
    } else throw Error(name);
    return Response.json({ result: { content: [{ text: JSON.stringify(result) }] } });
  } });
  const start = async (mounted, note) => {
    await mounted.view.refresh();
    await clickFollowup(mounted.container, { defer: 'Not now', file: 'File to existing deal', handled: 'Already handled' }[action]);
    fillFollowup(mounted.container, 'note', note);
    if (action === 'defer') fillFollowup(mounted.container, 'when', note === 'Original note' ? '2099-11-04T09:00' : '2099-11-05T09:00');
    if (action === 'file') { fillFollowup(mounted.container, 'deal', row.deal); await clickFollowup(mounted.container, 'Review selected deal'); }
    await clickFollowup(mounted.container, { defer: 'Defer follow-up', file: 'Confirm filing', handled: 'Confirm handled' }[action]);
  };
  const first = setup(client); await start(first, 'Original note');
  assert.equal(calls.length, 1); first.view.dispose();
  row.version++;
  const second = setup(client); await second.view.refresh();
  assert.equal(calls.length, 1);
  await clickFollowup(second.container, 'Check outcome');
  assert.equal(calls.length, 2, 'Check outcome must resend the retained request');
  assert.deepEqual(calls[1], calls[0]);
  assert.doesNotMatch(second.container.textContent, /Outcome unknown/);
  assert.match(second.container.textContent, action === 'defer' ? /Returns .*America\/Chicago/ : action === 'file' ? /Filed to the selected deal/ : /Marked handled/);
  second.view.dispose();
});

for (const error of ['email_new_deal_client_mismatch', 'email_filing_correction_reason_required']) test(`created deal allows correcting reason after ${error} without another creation`, async () => {
  const row = filingRow(), creates = [], previews = [], writes = [];
  const { container, view } = setup({ listEmailProposals: async () => response([row]),
    createDeal: async args => { creates.push(args); return { deal_id: 'created-demo' }; },
    previewEmailFiling: async args => {
      previews.push(args);
      if (!args.correction_reason) throw Object.assign(Error(error), { payload: { error } });
      return { ...row.preview, contract: 'email-followups.v2', deal: args.deal, base_version: row.version };
    },
    confirmEmailFiling: async args => { writes.push(args); return { ok: true, proposal_id: row.id, status: 'confirmed', version: 4, disposition: 'filed', note: args.note, deal: args.deal, activity_id: row.source.activity_id }; }
  });
  await view.refresh(); await clickFollowup(container, 'New deal');
  fillFollowup(container, 'name', 'Separate demo transaction'); fillFollowup(container, 'client', 'Different demo client');
  fillFollowup(container, 'note', 'Discussed by phone'); await clickFollowup(container, 'Create deal and review filing');
  fillFollowup(container, 'reason', 'Separate transaction for the selected client');
  await clickFollowup(container, 'Review created deal'); await clickFollowup(container, 'Cancel');
  assert.equal(container.querySelector('[data-field="reason"]').value, 'Separate transaction for the selected client');
  await clickFollowup(container, 'Review created deal'); await clickFollowup(container, 'Confirm filing');
  assert.equal(creates.length, 1); assert.equal(previews.length, 3); assert.equal(writes.length, 1);
  assert.equal(writes[0].deal, 'created-demo'); assert.equal(writes[0].correction_reason, 'Separate transaction for the selected client');
  assert.equal(writes[0].note, 'Discussed by phone'); view.dispose();
});

for (const outcome of ['lost', 'success', 'refusal', 'in-flight']) test(`changed-target remount reconciles original filing after ${outcome}`, async () => {
  const row = filingRow(), calls = [];
  const originalDeal = row.deal;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const client = createLiveClient({ selfActor: 'joe', fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    const { name, arguments: args } = JSON.parse(init.body).params;
    let result;
    if (name === 'list-email-proposals') result = response([row]);
    else if (name === 'deal-room-board') result = { deals: [] };
    else if (name === 'preview-email-filing') result = { ...row.preview, contract: 'email-followups.v2', deal: args.deal, base_version: row.version };
    else if (name === 'confirm-email-filing') {
      calls.push(args);
      if (calls.length === 1 && outcome === 'lost') throw Error('synthetic lost response');
      if (calls.length === 1 && outcome === 'in-flight') await waiting;
      result = outcome === 'refusal' ? { error: 'version_conflict' } : { ok: true, proposal_id: row.id, version: args.base_version + 1, note: args.note,
        status: 'confirmed', disposition: 'filed', deal: args.deal, activity_id: row.source.activity_id };
    } else throw Error(name);
    return Response.json({ result: { content: [{ text: JSON.stringify(result) }] } });
  } });
  const file = async (mounted, deal) => {
    await clickFollowup(mounted.container, 'File to existing deal');
    fillFollowup(mounted.container, 'deal', deal);
    await clickFollowup(mounted.container, 'Review selected deal');
    await clickFollowup(mounted.container, 'Confirm filing');
  };
  const first = setup(client); await first.view.refresh(); await file(first, originalDeal);
  assert.equal(calls.length, 1); first.view.dispose();
  const changedDeal = '20000000-0000-4000-8000-000000000002'; row.suggested_deals = [{ deal: changedDeal, name: 'Other demo', reasons: [] }];
  let reopened = setup(client); await reopened.view.refresh();
  if (outcome === 'in-flight') {
    reopened.view.dispose(); reopened = setup(client); await reopened.view.refresh();

  }
  if (outcome === 'lost' || outcome === 'in-flight') {
    assert.match(reopened.container.textContent, /Outcome unknown/, 'recover before offering a changed target');
    assert.equal([...reopened.container.querySelectorAll('button')].some(button => button.textContent === 'File to existing deal'), false);
    const checking = clickFollowup(reopened.container, 'Check outcome');
    if (outcome === 'in-flight') { release(); }
    await checking;
    assert.equal(calls.length, outcome === 'lost' ? 2 : 1);
    if (outcome === 'lost') assert.deepEqual(calls[1], calls[0]);
    assert.match(reopened.container.textContent, /Filed to the selected deal/);
    assert.equal(calls.every(args => args.deal === originalDeal), true);
  } else {
    await file(reopened, changedDeal);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].deal, '20000000-0000-4000-8000-000000000002');
    assert.notEqual(calls[1].idempotency_key, calls[0].idempotency_key);
  }
  reopened.view.dispose();
});

for (const outcome of ['offline', 'malformed']) test(`round-three changed-target remount retains original filing after ${outcome}`, async () => {
  const row = filingRow(), calls = [];
  const originalDeal = row.deal;
  let online = true;
  const client = createLiveClient({ online: () => online, selfActor: 'joe', fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    const { name, arguments: args } = JSON.parse(init.body).params;
    let result;
    if (name === 'list-email-proposals') result = response([row]);
    else if (name === 'deal-room-board') result = { deals: [] };
    else if (name === 'preview-email-filing') result = { ...row.preview, contract: 'email-followups.v2', deal: args.deal, base_version: row.version };
    else if (name === 'confirm-email-filing') {
      calls.push(args);
      if (calls.length === 1 && outcome === 'offline') throw Error('synthetic lost response');
      result = outcome === 'refusal' ? { error: 'version_conflict' } : { ok: true, proposal_id: row.id, version: args.base_version + 1, note: args.note,
        status: 'confirmed', disposition: 'filed', deal: calls.length === 1 && outcome === 'malformed' ? 'wrong-deal' : args.deal, activity_id: row.source.activity_id };
    } else throw Error(name);
    return Response.json({ result: { content: [{ text: JSON.stringify(result) }] } });
  } });
  const file = async (mounted, deal) => {
    await clickFollowup(mounted.container, 'File to existing deal');
    fillFollowup(mounted.container, 'deal', deal);
    await clickFollowup(mounted.container, 'Review selected deal');
    await clickFollowup(mounted.container, 'Confirm filing');
  };
  const first = setup(client); await first.view.refresh(); await file(first, originalDeal);
  assert.equal(calls.length, 1); first.view.dispose();
  if (outcome === 'offline') {
    const offline = setup(client); await offline.view.refresh(); online = false;
    await clickFollowup(offline.container, 'Check outcome');
    assert.match(offline.container.textContent, /Outcome unknown/);
    offline.view.dispose(); online = true;
  }
  const changedDeal = '20000000-0000-4000-8000-000000000002'; row.suggested_deals = [{ deal: changedDeal, name: 'Other demo', reasons: [] }];
  let reopened = setup(client); await reopened.view.refresh();
    assert.match(reopened.container.textContent, /Outcome unknown/, 'recover before offering a changed target');
    assert.equal([...reopened.container.querySelectorAll('button')].some(button => button.textContent === 'File to existing deal'), false);
    await clickFollowup(reopened.container, 'Check outcome');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
    assert.match(reopened.container.textContent, /Filed to the selected deal/);
    assert.equal(calls.every(args => args.deal === originalDeal), true);
  reopened.view.dispose();
});
