import test from 'node:test';
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
  const container = dom.window.document.querySelector('section');
  const view = mountEmailFollowups({ container, client, onChange: () => {}, ...options });
  return { dom, container, view, action: name => view.click({ target: [...container.querySelectorAll('button')].find(button => button.textContent === name) }) };
}

test('Home lists pending email evidence and proposed owner/date without exposing the raw sender', async () => {
  const { container, view } = setup({ listEmailProposals: async () => response([proposal()]) });
  await view.refresh();
  assert.match(container.textContent, /Email follow-ups/);
  assert.match(container.textContent, /Demo Harbor expansion/);
  assert.match(container.textContent, /Email sender/);
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
  assert.match(container.textContent, /No pending email follow-ups/);
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
  await view.refresh(); await action('Dismiss');
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

test('unknown confirmation locks other decisions and Check outcome replays the same request', async () => {
  const row = proposal(), calls = []; let release;
  const { container, view, action } = setup({ listEmailProposals: async () => response([row]),
    previewEmailNextStep: async () => row.preview,
    confirmEmailNextStep: async args => { calls.push(args); if (calls.length === 1) { await new Promise(resolve => { release = resolve; }); throw Error('lost response'); } return { ...row.preview, status: 'confirmed', requires_confirmation: false }; } });
  await view.refresh(); await action('Confirm');
  const pending = action('Confirm change');
  await Promise.resolve();
  assert.equal(container.querySelector('[data-email-action="confirm"]')?.disabled, true);
  release(); await pending;
  assert.match(container.textContent, /Outcome unknown/);
  assert.equal(container.querySelector('[data-email-action="dismiss"]'), null);
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
  assert.ok(container.querySelector('[data-email-action="dismiss"]'));
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
  await view.refresh(); await action('Dismiss');
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
  await view.refresh(); await action('Dismiss');
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
  await view.click({ target: container.querySelectorAll('[data-email-action="dismiss"]')[0] });
  await view.click({ target: container.querySelector('[data-email-action="dismiss"]') });
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
      await view.action('Dismiss');
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
