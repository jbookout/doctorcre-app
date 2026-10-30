import test, { afterEach } from 'node:test';
const windows = [];
afterEach(() => { windows.splice(0).forEach(win => win.close()); });
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
  const container = dom.window.document.querySelector('section');
  const view = mountEmailFollowups({ container, client: { selfActor: 'joe', ...client }, onChange: () => {}, ...options });
  return { dom, container, view, action: name => view.click({ target: [...container.querySelectorAll('button')].find(button => button.textContent === name) }) };
}

test('Home lists pending email evidence and proposed owner/date without exposing the raw sender', async () => {
  const { container, view } = setup({ listEmailProposals: async () => response([proposal()]) });
  await view.refresh();
  assert.match(container.textContent, /Email follow-ups/);
  assert.match(container.textContent, /Demo Harbor expansion/);
  assert.match(container.querySelector('.email-source').textContent, /^From an email, .* ago$/);
  assert.ok(container.querySelector('.email-source').title);
  assert.match(container.textContent, /Please send the revised plan by November 3\./);
  assert.match(container.textContent, /Send the revised plan/);
  assert.match(container.textContent, /Joe/);
  assert.match(container.textContent, /Nov 3/);
  assert.doesNotMatch(container.innerHTML, /private-sender|example.test/);
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

test('Dismiss requires a reason and sends the proposal version the user read', async () => {
  const row = proposal(), calls = [];
  const { container, view, action } = setup({ listEmailProposals: async () => response([row]),
    dismissEmailProposal: async args => { calls.push(args); return { ok: true, proposal_id: row.id, status: 'dismissed', version: 4 }; } });
  await view.refresh(); await action('Add a note');
  await action('Dismiss proposal');
  assert.equal(calls.length, 0);
  const reason = container.querySelector('textarea');
  assert.ok(reason); assert.equal(reason.maxLength, 500);
  reason.value = 'Already handled on the call';
  await action('Dismiss proposal');
  const { idempotency_key, ...args } = calls[0];
  assert.ok(idempotency_key);
  assert.deepEqual(args, { proposal_id: row.id, base_version: 3, reason: 'Already handled on the call' });
  assert.match(container.textContent, /Dismissed/);
});

test('mailbox display names use the prefix as text when sender metadata contains markup', async () => {
  const row = proposal(); row.source.sender = 'Dana <b>Demo</b> <dana@example.test>'; row.source.subject = '<img src=x onerror=alert(1)>Plan';
  const { container, view } = setup({ listEmailProposals: async () => response([row]) });
  await view.refresh();
  assert.match(container.querySelector('.email-source').textContent, /^From Dana's email, .* ago$/);
  assert.equal(container.querySelector('.email-source img, .email-source b'), null);
});

test('a dismiss chip dismisses in one tap with its text as the reason', async () => {
  const row = proposal(), calls = []; let changes = 0;
  const { container, view, action } = setup({ listEmailProposals: async () => response([row]),
    dismissEmailProposal: async args => { calls.push(args); return { ok: true, proposal_id: row.id, status: 'dismissed', version: 4 }; } }, { onChange: () => changes++ });
  await view.refresh();
  assert.deepEqual([...container.querySelectorAll('[data-email-chip]')].map(chip => chip.textContent), ['Already handled', 'Wrong deal', 'Not now']);
  await action('Not now');
  const { idempotency_key, ...args } = calls[0];
  assert.match(idempotency_key, /^[a-f0-9-]{36}$/);
  assert.deepEqual(args, { proposal_id: row.id, base_version: 3, reason: 'Not now' });
  assert.match(container.textContent, /Dismissed\./); assert.equal(changes, 1);
  assert.equal(container.querySelector('[data-email-chip]'), null);
  await action('Not now'); assert.equal(calls.length, 1);
});

test('a refused chip dismissal reports the refusal and an uncertain one offers Check outcome with the same request', async () => {
  const row = proposal(), calls = [];
  const refused = setup({ listEmailProposals: async () => response([row]),
    dismissEmailProposal: async () => { throw Object.assign(Error('conflict'), { payload: { error: 'version_conflict' } }); } });
  await refused.view.refresh(); await refused.action('Wrong deal');
  assert.match(refused.container.textContent, /changed/);
  const lost = setup({ listEmailProposals: async () => response([row]),
    dismissEmailProposal: async args => { calls.push(args); if (calls.length === 1) throw Error('lost response'); return { ok: true, proposal_id: row.id, status: 'dismissed' }; } });
  await lost.view.refresh(); await lost.action('Already handled');
  assert.match(lost.container.textContent, /Outcome unknown/);
  assert.equal(lost.container.querySelector('[data-email-chip]'), null);
  await lost.action('Check outcome');
  assert.deepEqual(calls[1], calls[0]); assert.equal(calls[0].reason, 'Already handled');
  assert.match(lost.container.textContent, /Dismissed\./);
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
  assert.ok(container.querySelector('[data-email-action="note"]'));
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
  release(response([proposal()])); await read;
  assert.doesNotMatch(second.container.textContent, /Demo Harbor|Please send/);
  view.dispose(); dom.window.close(); second.view.dispose(); second.dom.window.close();
});

test('refresh preserves a dismissal draft and typing focus', async () => {
  const { container, view, action, dom } = setup({ listEmailProposals: async () => response([proposal()]) });
  await view.refresh(); await action('Add a note');
  const textarea = container.querySelector('textarea');
  textarea.value = 'Already discussed'; textarea.focus(); textarea.setSelectionRange(7, 7);
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await view.refresh();
  const replacement = container.querySelector('textarea');
  assert.equal(replacement.value, 'Already discussed');
  assert.equal(dom.window.document.activeElement, replacement);
  assert.equal(replacement.selectionStart, 7);
});

test('a dismissal draft retains the version originally reviewed when a newer read arrives', async () => {
  const row = proposal(), calls = [];
  const { container, view, action, dom } = setup({ listEmailProposals: async () => response([structuredClone(row)]),
    dismissEmailProposal: async args => { calls.push(args); throw Object.assign(Error('conflict'), { payload: { error: 'version_conflict' } }); } });
  await view.refresh(); await action('Add a note');
  container.querySelector('textarea').value = 'Already handled';
  container.querySelector('textarea').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  row.version = 4; await view.refresh(); await action('Dismiss proposal');
  assert.equal(calls[0].base_version, 3);
  assert.match(container.textContent, /changed/);
});

test('opening a second dismissal focuses that proposal reason instead of the first open form', async () => {
  const second = { ...proposal(), id: '10000000-0000-4000-8000-000000000002' };
  const { container, view, dom } = setup({ listEmailProposals: async () => response([proposal(), second]) });
  await view.refresh();
  await view.click({ target: container.querySelectorAll('[data-email-action="note"]')[0] });
  await view.click({ target: container.querySelector('[data-email-action="note"]') });
  assert.equal(dom.window.document.activeElement.closest('article').dataset.emailId, second.id);
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
  assert.deepEqual(calls[0], { limit: 50 });
  await action('Load more email follow-ups');
  assert.match(container.textContent, /Demo Harbor expansion/);
  assert.match(container.textContent, /Could not load/);
  fail = false;
  await action('Retry email follow-ups');
  assert.match(container.textContent, /Demo second deal/);
  assert.deepEqual(calls.at(-1), { limit: 50, cursor: first.id });
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
  assert.match(container.textContent, /Could not load/);
  assert.equal(container.querySelectorAll('article').length, 0);
  assert.doesNotMatch(container.textContent, /No pending/);
});

for (const decision of ['dismiss', 'confirm']) test(`reopening a deal recovers the original uncertain ${decision} request`, async () => {
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
      result = name === 'dismiss-email-proposal' ? { ok: true, status: 'dismissed', proposal_id: row.id }
        : { ...row.preview, proposal_digest: args.proposal_digest, status: 'confirmed', requires_confirmation: false };
    }
    return Response.json({ result: { content: [{ text: JSON.stringify(result) }] } });
  } });
  async function decide(view, reason) {
    if (decision === 'dismiss') {
      await view.action('Add a note');
      view.container.querySelector('textarea').value = reason;
      await view.action('Dismiss proposal');
    } else {
      await view.action('Confirm');
      await view.action('Confirm change');
    }
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
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([row]),
    submitEmailDraft: async args => { calls.push(args); return draftReceipt(args); } });
  await view.refresh();
  assert.match(container.textContent, /Reply draft/);
  await action('Review reply');
  assert.match(container.textContent, /To: demo-correspondent@example.test/);
  assert.match(container.textContent, /CC: demo-partner@example.test/);
  assert.equal(calls.length, 0, 'opening a review never submits');
  editDraft(dom, container, 'subject', 'Re: Demo plan reviewed');
  editDraft(dom, container, 'body', '  I reviewed the plan.\nPlease send the dimensions.  ');
  await action('Submit');
  const { idempotency_key, ...sent } = calls[0];
  assert.ok(idempotency_key);
  assert.deepEqual(sent, { proposal_id: row.id, base_version: 3, subject: 'Re: Demo plan reviewed',
    body: '  I reviewed the plan.\nPlease send the dimensions.  ', to: ['demo-correspondent@example.test'], cc: ['demo-partner@example.test'] });
  assert.match(container.textContent, /Submitted for sending/);
  assert.match(container.textContent, /To: demo-correspondent@example.test/);
  assert.match(container.textContent, /CC: demo-partner@example.test/);
  assert.equal(container.querySelector('[data-email-action="submit-draft"]'), null);
});

test('reply edits survive refresh and version refusal without adopting a newer version', async () => {
  const row = replyDraft(), calls = [];
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([row]),
    submitEmailDraft: async args => { calls.push(args); throw Object.assign(Error('stale'), { payload: { error: 'version_conflict' } }); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'My unsent reply.');
  row.version = 4; row.reply_draft.body = 'A newer stored draft.';
  await view.refresh();
  assert.equal(container.querySelector('[data-email-body]').value, 'My unsent reply.');
  await action('Submit');
  assert.equal(calls[0].base_version, 3);
  assert.equal(container.querySelector('[data-email-body]').value, 'My unsent reply.');
  assert.match(container.textContent, /changed.*Refresh and review/);
});

test('reply submission loss locks editing and Check outcome replays the exact request after removal from the list', async () => {
  const row = replyDraft(), calls = []; let listed = [row];
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response(listed),
    submitEmailDraft: async args => { calls.push(args); if (calls.length === 1) { listed = []; throw Error('lost response'); } return draftReceipt(args); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Only send this once.');
  await action('Submit'); await view.refresh();
  assert.match(container.textContent, /Outcome unknown/);
  assert.equal(container.querySelector('[data-email-body]'), null);
  await action('Check outcome');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.match(container.textContent, /Submitted for sending/);
});

test('reply review cancels without writing, rejects empty text and clears private edits on identity loss', async () => {
  let writes = 0;
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([replyDraft()]),
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
  const { container, view, action } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async args => ({ ...draftReceipt(args), body: 'Wrong text' }) });
  await view.refresh(); await action('Review reply'); await action('Submit');
  assert.match(container.textContent, /Outcome unknown/);
  assert.doesNotMatch(container.textContent, /Submitted for sending/);
});

for (const malformed of [
  { to: ['different@example.test'] }, { cc: ['different@example.test'] }, { cc: [] }, { to: ['missing-at.example.test'] }, { cc: ['bad address@example.test'] },
  { version: 99 }, { proposal_id: 'different-proposal' }, { sha256: 'invalid' },
]) test(`reply submission never claims success for a malformed ${Object.keys(malformed)[0]} receipt`, async () => {
  const { container, view, action } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async args => ({ ...draftReceipt(args), ...malformed }) });
  await view.refresh(); await action('Review reply'); await action('Submit');
  assert.match(container.textContent, /Outcome unknown/);
  assert.doesNotMatch(container.textContent, /Submitted for sending/);
});

test('reply CC-address refusal keeps the edited text available for the owning partner', async () => {
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([replyDraft()]),
    submitEmailDraft: async () => { throw Object.assign(Error('missing copy'), { payload: { error: 'email_draft_copy_address_missing' } }); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'Preserve my exact edits.');
  await action('Submit');
  assert.equal(container.querySelector('[data-email-body]').value, 'Preserve my exact edits.');
  assert.match(container.textContent, /other partner needs an email address/);
  assert.doesNotMatch(container.textContent, /Submitted for sending/);
});

test('a reply version conflict requires explicit fresh review while preserving partner edits', async () => {
  const row = replyDraft(), calls = []; let conflict = true;
  const { dom, container, view, action } = setup({ listEmailProposals: async () => response([row]),
    submitEmailDraft: async args => { calls.push(args); if (conflict) throw Object.assign(Error('conflict'), { payload: { error: 'version_conflict' } }); return draftReceipt(args); } });
  await view.refresh(); await action('Review reply');
  editDraft(dom, container, 'body', 'My revised reply must survive.');
  row.version = 4; row.reply_draft.body = 'Updated saved original.';
  await action('Submit');
  assert.ok([...container.querySelectorAll('button')].some(button => button.textContent === 'Review updated draft'));
  await view.refresh();
  assert.equal(calls.length, 1, 'background refresh never resubmits');
  assert.equal(container.querySelector('[data-email-body]').value, 'My revised reply must survive.');
  await action('Review updated draft');
  assert.match(container.textContent, /Updated saved original\./);
  assert.equal(calls.length, 1, 'fresh review never submits');
  conflict = false;
  await action('Submit');
  assert.equal(calls[1].base_version, 4);
  assert.equal(calls[1].body, 'My revised reply must survive.');
  assert.notEqual(calls[0].idempotency_key, calls[1].idempotency_key);
  assert.match(container.textContent, /Submitted for sending/);
});

for (const actor of ['joe', 'dell', null]) test(`reply review is offered only to its owner when signed in as ${actor}`, async () => {
  const { container, view } = setup({ selfActor: actor, listEmailProposals: async () => response([replyDraft()]) });
  await view.refresh();
  assert.equal(Boolean(container.querySelector('[data-email-action="edit-draft"]')), actor === 'joe');
  assert.ok(container.querySelector('[data-email-action="note"]'));
});

test('recipient changes preserve reviewed addresses across refresh and require explicit fresh review after refusal', async () => {
  const row = replyDraft(), calls = []; let changed = true;
  const { container, view, action } = setup({ listEmailProposals: async () => response([row]),
    submitEmailDraft: async args => { calls.push(args); if (changed) throw Object.assign(Error('changed'), { payload: { error: 'email_draft_recipients_mismatch' } }); return { ...draftReceipt(args), to: args.to, cc: args.cc }; } });
  await view.refresh(); await action('Review reply');
  row.reply_draft.to[0] = 'updated-sender@example.test';
  row.reply_draft.cc = ['updated-partner@example.test'];
  await view.refresh();
  assert.match(container.textContent, /To: demo-correspondent@example.test/);
  assert.doesNotMatch(container.textContent, /updated-sender/);
  await action('Submit');
  assert.deepEqual(calls[0].to, ['demo-correspondent@example.test']);
  assert.deepEqual(calls[0].cc, ['demo-partner@example.test']);
  assert.match(container.textContent, /Recipients changed/);
  assert.equal(container.querySelector('[data-email-action="submit-draft"]'), null);
  await action('Review updated draft');
  assert.match(container.textContent, /To: updated-sender@example.test/);
  assert.match(container.textContent, /CC: updated-partner@example.test/);
  assert.equal(calls.length, 1);
  changed = false;
  await action('Submit');
  assert.deepEqual(calls[1].to, ['updated-sender@example.test']);
  assert.deepEqual(calls[1].cc, ['updated-partner@example.test']);
  assert.match(container.textContent, /Submitted for sending/);
});

for (const recipients of [{ to: [] }, { cc: [] }, { to: ['bad address'] }]) test(`invalid reply recipients prevent review ${JSON.stringify(recipients)}`, async () => {
  const row = replyDraft(); Object.assign(row.reply_draft, recipients);
  const { container, view } = setup({ listEmailProposals: async () => response([row]) });
  await view.refresh();
  assert.match(container.textContent, /Could not load/);
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
  const row = replyDraft(); delete row.reply_draft.to; delete row.reply_draft.cc;
  row.confirm_verb = null; row.preview_error = code;
  const { container, view } = setup({ listEmailProposals: async () => response([row, { ...proposal(), id: 'another-proposal' }]) });
  await view.refresh();
  assert.equal(container.querySelectorAll('article').length, 2);
  assert.match(container.textContent, /Recipient addresses are unavailable/);
  assert.equal(container.querySelector('[data-email-action="edit-draft"]'), null);
  assert.equal(container.querySelectorAll('[data-email-action="note"]').length, 2);
  assert.doesNotMatch(container.textContent, /Could not load/);
});

test('filing proposals show evidence and confirm the displayed existing deal', async () => {
  const row = proposal(); row.kind = 'file_to_deal'; row.confirm_verb = 'confirm-email-filing';
  row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: row.deal,
    activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote, sender_role: 'lender',
    sender: { name: 'Demo Lender', party_id: 'demo-contact' }, new_people: [], text: null, requires_confirmation: true, proposal_digest: digest };
  let request;
  const { container, view, action } = setup({ listEmailProposals: async () => response([row]),
    confirmEmailFiling: async args => { request = args; return { ok: true, status: 'confirmed', deal: row.deal, activity_id: row.source.activity_id }; } });
  await view.refresh();
  assert.match(container.textContent, /Demo Lender/);
  await action('Review filing'); await action('Confirm filing');
  assert.equal(request.proposal_id, row.id); assert.equal(request.base_version, row.version);
  assert.equal(request.proposal_digest, digest); assert.equal(request.deal, undefined);
  assert.match(container.textContent, /Confirmed/);
});

test('possible new matter creates a deal and confirms it with the filing proposal', async () => {
  const row = proposal(); row.kind = 'possible_new_deal'; row.deal = null; row.deal_name = null; row.proposed_matter = 'Possible new practice'; row.confirm_verb = 'confirm-email-filing';
  row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: null,
    activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote, sender_role: 'client',
    sender: { name: 'Demo Client', party_id: 'demo-contact' }, new_people: [], text: row.proposed_matter, requires_confirmation: true, proposal_digest: digest };
  const calls = [];
  const { container, view, action, dom } = setup({ listEmailProposals: async () => response([row]),
    createDeal: async args => { calls.push(['create', args]); return { status: 'ok', deal_id: 'created-deal' }; },
    confirmEmailFiling: async args => { calls.push(['confirm', args]); return { ok: true, status: 'confirmed', deal: 'created-deal', activity_id: row.source.activity_id }; } });
  await view.refresh(); assert.match(container.textContent, /Possible new practice/);
  await action('Review filing');
  for (const [key, value] of [['deal-name', 'Demo practice'], ['deal-client', 'Demo Client']]) {
    const input = container.querySelector(`[data-email-${key}]`); input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  await action('Create deal and confirm filing');
  assert.equal(calls[0][1].name, 'Demo practice'); assert.equal(calls[0][1].client, 'Demo Client');
  assert.equal(calls[1][1].deal, 'created-deal'); assert.equal(calls[1][1].proposal_digest, digest);
  assert.match(container.textContent, /Confirmed/);
});

test('unknown proposal kinds are ignored without hiding known proposals', async () => {
  const { container, view } = setup({ listEmailProposals: async () => response([{ id: 'future', kind: 'future_kind' }, proposal()]) });
  await view.refresh(); assert.match(container.textContent, /Demo Harbor expansion/); assert.doesNotMatch(container.textContent, /Could not load/);
});

test('uncertain new-deal creation retries the same request and confirms only once', async () => {
  const row = proposal(); Object.assign(row, { kind: 'possible_new_deal', deal: null, deal_name: null, proposed_matter: 'New matter', confirm_verb: 'confirm-email-filing' });
  row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: null, activity_id: row.source.activity_id,
    evidence_quote: row.source.evidence_quote, sender_role: 'client', sender: { name: 'Demo Client', party_id: 'demo-contact' }, new_people: [], requires_confirmation: true, proposal_digest: digest };
  const creates = [], confirmations = [];
  const { container, view, action, dom } = setup({ listEmailProposals: async () => response([row]),
    createDeal: async args => { creates.push(args); if (creates.length === 1) throw Error('lost'); return { deal_id: 'created-deal' }; },
    confirmEmailFiling: async args => { confirmations.push(args); return { ok: true, status: 'confirmed', deal: args.deal, activity_id: row.source.activity_id }; } });
  await view.refresh(); await action('Review filing');
  for (const [key, value] of [['deal-name', 'Demo deal'], ['deal-client', 'Demo Client']]) {
    const input = container.querySelector(`[data-email-${key}]`); input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  await action('Create deal and confirm filing'); assert.match(container.textContent, /outcome unknown/i);
  await action('Check outcome'); assert.deepEqual(creates[0], creates[1]); assert.equal(confirmations.length, 1);
});

test('filing refusals show the server public hint', async () => {
  for (const code of ['email_new_deal_client_mismatch', 'email_new_deal_not_found', 'email_thread_not_continuous', 'email_thread_ambiguous', 'email_thread_recipient_changed', 'email_sender_contact_required', 'email_proposal_stale']) {
    const row = proposal(); row.kind = 'file_to_deal'; row.confirm_verb = 'confirm-email-filing';
    row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: row.deal, activity_id: row.source.activity_id,
      evidence_quote: row.source.evidence_quote, sender_role: 'lender', sender: { name: 'Demo', party_id: 'demo-contact' }, new_people: [], requires_confirmation: true, proposal_digest: digest };
    const { container, view, action } = setup({ listEmailProposals: async () => response([row]), confirmEmailFiling: async () => { throw Object.assign(Error('refused'), { payload: { error: code, hint: `Public hint for ${code}` } }); } });
    await view.refresh(); await action('Review filing'); await action('Confirm filing');
    assert.match(container.textContent, new RegExp(`Public hint for ${code}`));
  }
});

test('a filing refusal after creation preserves the created deal and cannot create it twice', async () => {
  const row = proposal(); Object.assign(row, { kind: 'possible_new_deal', deal: null, deal_name: null, proposed_matter: 'New matter', confirm_verb: 'confirm-email-filing' });
  row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: null, activity_id: row.source.activity_id,
    evidence_quote: row.source.evidence_quote, sender_role: 'client', sender: { name: 'Demo Client', party_id: 'demo-contact' }, new_people: [], requires_confirmation: true, proposal_digest: digest };
  let creates = 0;
  const { container, view, action, dom } = setup({ listEmailProposals: async () => response([row]),
    createDeal: async () => { creates++; return { deal_id: 'created-deal' }; },
    confirmEmailFiling: async () => { throw Object.assign(Error('refused'), { payload: { error: 'email_new_deal_client_mismatch', hint: 'Choose a deal belonging to the email client.' } }); } });
  await view.refresh(); await action('Review filing');
  for (const [key, value] of [['deal-name', 'Demo deal'], ['deal-client', 'Demo Client']]) {
    const input = container.querySelector(`[data-email-${key}]`); input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  await action('Create deal and confirm filing');
  assert.match(container.textContent, /Choose a deal belonging to the email client/);
  assert.equal(container.querySelector('a[href="/deals?deal=created-deal"]').textContent, 'Open created deal');
  assert.equal(container.querySelector('[data-email-action="create-filing"]'), null); assert.equal(creates, 1);
});

test('filing confirmation keeps the proposal version reviewed before refresh', async () => {
  const row = proposal(); row.kind = 'file_to_deal'; row.confirm_verb = 'confirm-email-filing';
  row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: row.deal, activity_id: row.source.activity_id,
    evidence_quote: row.source.evidence_quote, sender_role: 'client', sender: { name: 'Demo', party_id: 'demo-contact' }, new_people: [], requires_confirmation: true, proposal_digest: digest };
  let current = row, sent;
  const { view, action } = setup({ listEmailProposals: async () => response([current]), confirmEmailFiling: async args => { sent = args; return { ok: true, status: 'confirmed', deal: row.deal, activity_id: row.source.activity_id }; } });
  await view.refresh(); await action('Review filing'); current = { ...row, version: 4 }; await view.refresh(); await action('Confirm filing');
  assert.equal(sent.base_version, 3);
});

test('after a client mismatch the partner may deliberately create a corrected deal and retains the first link', async () => {
  const row = proposal(); Object.assign(row, { kind: 'possible_new_deal', deal: null, deal_name: null, proposed_matter: 'New matter', confirm_verb: 'confirm-email-filing' });
  row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: null, activity_id: row.source.activity_id,
    evidence_quote: row.source.evidence_quote, sender_role: 'client', sender: { name: 'Demo', party_id: 'demo-contact' }, new_people: [], requires_confirmation: true, proposal_digest: digest };
  const created = [], confirmed = [];
  const { container, view, action, dom } = setup({ listEmailProposals: async () => response([row]), createDeal: async args => { created.push(args); return { deal_id: `created-${created.length}` }; },
    confirmEmailFiling: async args => { confirmed.push(args); if (confirmed.length === 1) throw Object.assign(Error('refused'), { payload: { error: 'email_new_deal_client_mismatch', hint: 'Choose a deal belonging to the email client.' } }); return { ok: true, status: 'confirmed', deal: args.deal, activity_id: row.source.activity_id }; } });
  const enter = (key, value) => { const input = container.querySelector(`[data-email-${key}]`); input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  await view.refresh(); await action('Review filing'); enter('deal-name', 'First deal'); enter('deal-client', 'Wrong client'); await action('Create deal and confirm filing');
  assert.equal(created.length, 1); await action('Create a corrected deal');
  assert.ok(container.querySelector('a[href="/deals?deal=created-1"]'));
  enter('deal-name', 'Corrected deal'); enter('deal-client', 'Right client'); await action('Create deal and confirm filing');
  assert.equal(created.length, 2); assert.equal(confirmed[1].deal, 'created-2'); assert.match(container.textContent, /Confirmed/);
});

test('unknown, null, missing and duplicate future proposal kinds do not hide supported proposals', async () => {
  const { container, view } = setup({ listEmailProposals: async () => response([null, {}, { kind: 'future' }, { kind: 'future' }, proposal()]) });
  await view.refresh(); assert.match(container.textContent, /Demo Harbor expansion/); assert.doesNotMatch(container.textContent, /Could not load/);
});


test('unknown sender must become a contact before a new deal can be created', async () => {
  const row = proposal();
  Object.assign(row, { kind: 'possible_new_deal', deal: null, deal_name: null, confirm_verb: 'confirm-email-filing' });
  row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: null,
    activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote,
    sender: { name: 'Demo sender', party_id: null }, new_people: [], requires_confirmation: true, proposal_digest: digest };
  const writes = [];
  const { container, view, action } = setup({ listEmailProposals: async () => response([row]),
    createDeal: async args => { writes.push(args); return { deal_id: 'orphan' }; },
    confirmEmailFiling: async args => { writes.push(args); } });
  await view.refresh(); await action('Review filing');
  assert.match(container.textContent, /Add the sender as a contact first/);
  assert.equal(container.querySelector('[data-email-action="create-filing"]'), null);
  await action('Create deal and confirm filing');
  assert.deepEqual(writes, []);
  await action('Cancel');
  assert.ok(container.querySelector('[data-email-action="review-filing"]'));
});

for (const code of ['unhandled_verb_failure', 'not_a_client', 'deal_name_exists']) test(`new-deal refusal ${code} allows correction or cancellation without resending identical details`, async () => {
  const row = proposal();
  Object.assign(row, { kind: 'possible_new_deal', deal: null, deal_name: null, confirm_verb: 'confirm-email-filing' });
  row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: null,
    activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote,
    sender: { name: 'Demo Client', party_id: 'demo-contact' }, new_people: [], requires_confirmation: true, proposal_digest: digest };
  const creates = [], confirmations = [];
  const client = createLiveClient({ selfActor: 'joe', fetchImpl: async (path, init) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    let result;
    if (name === 'list-email-proposals') result = response([row]);
    else if (name === 'new-deal') {
      creates.push(args);
      if (creates.length === 1) return Response.json({ result: { isError: true, content: [{ text: JSON.stringify({ error: code }) }] } });
      result = { deal_id: 'corrected-deal' };
    } else if (name === 'get-deal-room') result = { base_version: 1 };
    else if (name === 'set-lead') result = { ok: true };
    else if (name === 'confirm-email-filing') { confirmations.push(args); result = { ok: true, status: 'confirmed', deal: args.deal, activity_id: row.source.activity_id }; }
    else throw Error(`Unexpected verb ${name}`);
    return Response.json({ result: { content: [{ text: JSON.stringify(result) }] } });
  } });
  const { container, view, action, dom } = setup(client);
  const enter = (key, value) => { const input = container.querySelector(`[data-email-${key}]`); input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  await view.refresh(); await action('Review filing');
  enter('deal-name', 'Demo office'); enter('deal-client', 'Mistyped client'); await action('Create deal and confirm filing');
  assert.ok(container.querySelector('[data-email-action="cancel"]'));
  assert.ok([...container.querySelectorAll('button')].some(button => button.textContent === 'Edit deal details'));
  assert.equal(container.querySelector('[data-email-action="replay"]'), null);
  await action('Edit deal details'); await action('Create deal and confirm filing');
  assert.equal(creates.length, 1);
  await action('Cancel'); await action('Review filing');
  enter('deal-name', 'Demo office'); enter('deal-client', 'Mistyped client'); await action('Create deal and confirm filing');
  assert.equal(creates.length, 1);
  enter('deal-client', 'Demo Client'); await action('Create deal and confirm filing');
  assert.equal(creates.length, 2);
  assert.notEqual(creates[0].idempotency_key, creates[1].idempotency_key);
  assert.equal(confirmations.length, 1);
  assert.match(container.textContent, /Confirmed\./);
  view.dispose(); dom.window.close();
});

for (const field of ['deal', 'activity_id', 'status']) test(`filing receipt with a mismatched ${field} keeps the outcome unknown`, async () => {
  const row = proposal(); Object.assign(row, { kind: 'file_to_deal', confirm_verb: 'confirm-email-filing' });
  row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: row.deal,
    activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote,
    sender: { party_id: 'demo-contact' }, new_people: [], requires_confirmation: true, proposal_digest: digest };
  const writes = []; let changes = 0;
  const { container, view, action } = setup({ listEmailProposals: async () => response([row]),
    confirmEmailFiling: async args => { writes.push(args); return { ok: true, status: 'confirmed', deal: row.deal, activity_id: row.source.activity_id, [field]: 'wrong' }; } },
  { onChange: () => changes++ });
  await view.refresh(); await action('Review filing'); await action('Confirm filing');
  assert.match(container.textContent, /Outcome unknown/);
  assert.doesNotMatch(container.textContent, /Confirmed\./);
  assert.equal(changes, 0);
  await action('Check outcome');
  assert.deepEqual(writes[1], writes[0]);
});

for (const kind of ['file_to_deal', 'possible_new_deal']) test(`partner can dismiss ${kind} with the reviewed version and a reason`, async () => {
  const row = proposal(); Object.assign(row, { kind, confirm_verb: 'confirm-email-filing', preview: null,
    ...(kind === 'possible_new_deal' ? { deal: null, deal_name: null } : {}) });
  const writes = []; let changes = 0;
  const { container, view, action, dom } = setup({ listEmailProposals: async () => response([row]),
    dismissEmailProposal: async args => { writes.push(args); return { ok: true, status: 'dismissed', proposal_id: row.id }; },
    createDeal: async () => assert.fail('Dismiss must never create a deal'),
    confirmEmailFiling: async () => assert.fail('Dismiss must never confirm filing') }, { onChange: () => changes++ });
  await view.refresh(); await action('Add a note'); await action('Dismiss proposal');
  assert.equal(writes.length, 0);
  container.querySelector('textarea').value = 'Already handled';
  await action('Dismiss proposal');
  assert.deepEqual(writes[0], { proposal_id: row.id, base_version: 3, reason: 'Already handled', idempotency_key: writes[0].idempotency_key });
  assert.match(writes[0].idempotency_key, /^[a-f0-9-]{36}$/);
  assert.match(container.textContent, /Dismissed\./); assert.equal(changes, 1);
  await action('Dismiss proposal'); assert.equal(writes.length, 1);
  view.dispose(); dom.window.close();
});

for (const failedVerb of ['get-deal-room', 'set-lead']) test(`failure in ${failedVerb} after deal creation recovers the same deal`, async () => {
  const row = proposal(); Object.assign(row, { kind: 'possible_new_deal', deal: null, deal_name: null, confirm_verb: 'confirm-email-filing' });
  row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: null,
    activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote,
    sender: { party_id: 'demo-contact' }, new_people: [], requires_confirmation: true, proposal_digest: digest };
  let creates = 0, failures = 0;
  const client = createLiveClient({ selfActor: 'joe', fetchImpl: async (path, init) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    if (name === failedVerb && failures++ === 0) return Response.json({ result: { isError: true, content: [{ text: JSON.stringify({ error: 'unhandled_verb_failure' }) }] } });
    const result = name === 'list-email-proposals' ? response([row]) : name === 'new-deal' ? (creates++, { deal_id: 'created-once' })
      : name === 'get-deal-room' ? { base_version: 1 } : name === 'set-lead' ? { ok: true }
        : { ok: true, status: 'confirmed', deal: args.deal, activity_id: row.source.activity_id };
    return Response.json({ result: { content: [{ text: JSON.stringify(result) }] } });
  } });
  const { container, view, action, dom } = setup(client);
  await view.refresh(); await action('Review filing');
  for (const [key, value] of [['deal-name', 'Demo office'], ['deal-client', 'Demo Client']]) {
    const input = container.querySelector(`[data-email-${key}]`); input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  await action('Create deal and confirm filing');
  assert.ok(container.querySelector('[data-email-action="replay"]'));
  assert.equal(container.querySelector('[data-email-action="edit-filing"]'), null);
  await action('Check outcome');
  assert.equal(creates, 1); assert.match(container.textContent, /Confirmed\./);
  view.dispose(); dom.window.close();
});

test('offline new-deal creation keeps the original request available after reconnect', async () => {
  const row = proposal(); Object.assign(row, { kind: 'possible_new_deal', deal: null, deal_name: null, confirm_verb: 'confirm-email-filing' });
  row.preview = { contract: 'email-filing.v1', proposal_id: row.id, kind: row.kind, deal: null,
    activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote,
    sender: { party_id: 'demo-contact' }, new_people: [], requires_confirmation: true, proposal_digest: digest };
  let online = false, creates = 0;
  const client = createLiveClient({ selfActor: 'joe', online: () => online, fetchImpl: async (path, init) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    const result = name === 'list-email-proposals' ? response([row]) : name === 'new-deal' ? (creates++, { deal_id: 'created-once' })
      : name === 'get-deal-room' ? { base_version: 1 } : name === 'set-lead' ? { ok: true }
        : { ok: true, status: 'confirmed', deal: args.deal, activity_id: row.source.activity_id };
    return Response.json({ result: { content: [{ text: JSON.stringify(result) }] } });
  } });
  const { container, view, action, dom } = setup(client);
  await view.refresh(); await action('Review filing');
  for (const [key, value] of [['deal-name', 'Demo office'], ['deal-client', 'Demo Client']]) {
    const input = container.querySelector(`[data-email-${key}]`); input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  await action('Create deal and confirm filing');
  assert.equal(creates, 0); assert.ok(container.querySelector('[data-email-action="replay"]'));
  online = true; await action('Check outcome');
  assert.equal(creates, 1); assert.match(container.textContent, /Confirmed\./);
  view.dispose(); dom.window.close();
});

test('Home caps email cards and expands distinct dismissal reasons on demand', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...proposal(), id: `demo-${i}` }));
  const { container, view, action } = setup({ listEmailProposals: async () => response(rows) });
  const pending = view.refresh();
  assert.ok(container.querySelector('.home-followup-skeleton'));
  await pending;
  assert.equal(container.querySelectorAll('article').length, 2);
  assert.match(container.textContent, /Showing 2 of 5/);
  assert.equal(container.querySelectorAll('details.email-dismiss').length, 2);
  assert.equal(container.querySelector('summary').textContent, 'Dismiss');
  assert.deepEqual([...container.querySelector('details').querySelectorAll('[data-email-chip]')].map(node => node.textContent), ['Already handled', 'Wrong deal', 'Not now']);
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
