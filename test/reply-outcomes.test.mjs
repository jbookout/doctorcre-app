import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountReplyOutcomes } from '../js/reply-outcomes.js';
import { createLiveClient } from '../js/live-client.js';
import { createFixtureClient } from '../js/fixture-client.js';

const row = (failure_reason_code = null) => ({ id: 'outcome-1', deal: 'deal-1', subject: 'Demo reply <script>bad()</script>', outcome: failure_reason_code ? 'failed' : 'sent', result_recorded_at: '2026-10-28T12:00:00Z', failure_reason_code });
const page = (proposals = [row()]) => ({ schema_version: 'email-reply-outcomes.v1', proposals, send: false, more: false, next_cursor: null });
const waiting = () => ({ schema_version: 'email-proposals.v1', proposals: [], send: false, more: false, next_cursor: null });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(t, read = () => page(), selfActor = 'joe', pendingRead = waiting) {
  const dom = new JSDOM('<section></section>');
  const container = dom.window.document.querySelector('section');
  const requests = [];
  let actor = selfActor;
  const client = createLiveClient({ selfActor, fetchImpl: async (_url, init) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    requests.push({ name, args });
    const result = name === 'deal-room-board' ? { actor, deals: [] } : args.mode ? await read(args) : await pendingRead(args);
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }), { headers: { 'content-type': 'application/json' } });
  } });
  const view = mountReplyOutcomes({ container, client });
  t.after(() => { view.dispose(); dom.window.close(); });
  return { dom, container, view, client, requests, async actor(value) { actor = value; await client.getBoard(); view.syncActor(); await tick(); } };
}

test('sent replies labels all public failure reasons without rendering remote text as HTML', async t => {
  const reasons = {
    invalid_submission: 'The submitted reply was invalid.',
    submission_hash_mismatch: 'The submitted reply did not match the approved content.',
    submission_recipients_invalid: 'The submitted recipients were invalid.',
    aborted_before_dispatch: 'Sending stopped before dispatch.',
    unconfirmed_after_dispatch: 'Delivery could not be confirmed after dispatch.',
    delivery_failed: 'Delivery failed.',
  };
  for (const [code, text] of Object.entries(reasons)) {
    const { view, container } = setup(t, () => page([row(code)]));
    await view.refresh();
    assert.ok(container.textContent.includes(text));
    assert.ok(container.textContent.includes('<script>bad()</script>'));
    assert.equal(container.querySelector('script'), null);
  }
});

test('old and malformed outcomes reads remain unavailable and never claim empty', async t => {
  for (const value of [waiting(), page([{ ...row(), result_recorded_at: null }]), page([row('private reason')]),
    { ...page(), more: true, next_cursor: null }, { ...page(), send: true }]) {
    const { view, container } = setup(t, () => value);
    await view.refresh();
    assert.match(container.textContent, /Could not load recent reply outcomes/);
    assert.doesNotMatch(container.textContent, /No recorded reply outcomes|Demo reply/);
  }
});

test('refresh errors retain explicit last-successful outcomes and retry through the record client', async t => {
  let fail = false;
  const { view, container, requests } = setup(t, () => { if (fail) throw Error('offline'); return page(); });
  await view.refresh(); fail = true; await view.refresh();
  assert.match(container.textContent, /Showing the last successful read/);
  assert.match(container.textContent, /Demo reply/);
  fail = false;
  container.querySelector('[data-reply-retry="recent"]').click(); await tick();
  assert.doesNotMatch(container.textContent, /Could not load/);
  assert.ok(requests.every(request => request.name === 'list-email-proposals'));
  assert.deepEqual(requests[0].args, { mode: 'recent_outcomes', limit: 20 });
});

test('session invalidation clears outcomes and fences late successful reads', async t => {
  let resolve;
  const { view, container, dom, requests } = setup(t, () => new Promise(done => { resolve = done; }));
  const read = view.refresh(); await tick();
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  resolve(page()); await read;
  assert.match(container.textContent, /Sign in/);
  assert.doesNotMatch(container.textContent, /Demo reply/);
  const before = requests.length; await view.refresh(); assert.equal(requests.length, before);
});

test('unknown identity waits for the verified partner and later identity changes clear its outcomes', async t => {
  const state = setup(t, () => page(), null);
  await state.view.refresh();
  assert.equal(state.requests.length, 0);
  await state.actor('joe');
  assert.match(state.container.textContent, /Demo reply/);
  await state.actor('dell');
  assert.match(state.container.textContent, /Sign in/);
  assert.doesNotMatch(state.container.textContent, /Demo reply/);
});

test('nonpartner viewers do not read reply outcomes', async t => {
  const { view, requests, container } = setup(t, () => page(), 'observer');
  await view.refresh(); assert.equal(requests.length, 0); assert.match(container.textContent, /Sign in as a partner/);
});

test('fixture proposal reads expose recent mode and an owned submitted pending reply', async () => {
  const client = await createFixtureClient({ emailReplyDrafts: true, seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}` });
  assert.deepEqual(await client.listEmailProposals({ mode: 'recent_outcomes', limit: 20 }), page([]));
  const draft = (await client.listEmailProposals()).proposals.find(item => item.kind === 'reply_draft');
  await client.submitEmailDraft({ proposal_id: draft.id, base_version: draft.version, subject: 'Edited synthetic subject', body: 'Synthetic body', to: draft.reply_draft.to, cc: draft.reply_draft.cc, idempotency_key: 'fixture-outcome' });
  const result = await client.listEmailProposals({ status: 'approved_to_send', limit: 20 });
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].status, 'approved_to_send');
  assert.equal(result.proposals[0].submitted_email.subject, 'Edited synthetic subject');
  assert.equal(result.proposals[0].reply_draft.owner, client.selfActor);
  assert.equal(result.proposals[0].send_result, null);
});

test('a recorded outcome takes precedence over an overlapping pending read', async t => {
  const { view, container } = setup(t, () => page(), 'joe', () => ({ ...waiting(), proposals: [{ id: 'outcome-1', deal: 'deal-1', kind: 'reply_draft', status: 'approved_to_send', reply_draft: { owner: 'joe' }, submitted_email: { subject: 'Demo stale pending' }, send_result: null }] }));
  await view.refresh();
  assert.match(container.textContent, /Sent/);
  assert.doesNotMatch(container.textContent, /Demo stale pending/);
  assert.equal(container.querySelectorAll('[data-reply-outcome]').length, 1);
});

test('refresh preserves keyboard focus on the same reply deal link', async t => {
  const { view, container, dom } = setup(t);
  await view.refresh();
  container.querySelector('[data-reply-outcome="outcome-1"] a').focus();
  await view.refresh();
  assert.equal(dom.window.document.activeElement.tagName, 'A');
  assert.equal(dom.window.document.activeElement.getAttribute('href'), '/deals?deal=deal-1');
  assert.equal(dom.window.document.activeElement.closest('[data-reply-outcome]').dataset.replyOutcome, 'outcome-1');
});
