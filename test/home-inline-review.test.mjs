import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/ui/home/review.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseReview } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const ref = kind => ({ kind, item_id: 'one', source_version: 'v1', operations: kind === 'action' ? ['complete-one-action'] : ['edit-email-draft', 'dismiss-email-proposal', 'submit-email-draft'] });
const reply = { reply_draft: { subject: 'Synthetic subject', body: 'Synthetic body', to: ['demo@example.test'], cc: ['copy@example.test'] } };
const bound = { proposal_id: '00000000-0000-0000-0000-000000000001', base_version: 1 };
test('inline_review_shows_only_supported_operations', () => {
  const reference = ref('reply_draft');
  const result = parseReview({ ok: true, schema_version: 'home-review.v1', reference, detail: reply, operations: [{ verb: 'edit-email-draft', args: bound }, { verb: 'dismiss-email-proposal', args: bound }] }, reference);
  assert.deepEqual(result.operations.map(choice => choice.verb), ['edit-email-draft', 'dismiss-email-proposal']);
  assert.throws(() => parseReview({ ok: true, schema_version: 'home-review.v1', reference, detail: reply, operations: [{ verb: 'delete-deal', args: bound }] }, reference), /supported/);
});
test('detail refuses a different card or version', () => {
  const reference = ref('reply_draft');
  for (const changed of [{ item_id: 'other' }, { source_version: 'v2' }, { kind: 'action' }]) assert.throws(() => parseReview({ ok: true, schema_version: 'home-review.v1', reference: { ...reference, ...changed }, detail: reply, operations: [] }, reference));
});
const inboxBundle = await build({ entryPoints: ['src/ui/home/inbox.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { createInboxClient, parseItem } = await import(`data:text/javascript;base64,${Buffer.from(inboxBundle.outputFiles[0].text).toString('base64')}`);
const row = { item_id: 'one', source_id: bound.proposal_id, source_type: 'email_proposal', source_version: 'v1', source_state: 'needs_attention', title: 'Synthetic reply', activity_at: '2026-11-03T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', context_label: null, due_on: null, open_url: null, kind_label: 'Reply draft', merged_source_ids: [], action_id: null, action_version: null, deal_id: null, auto_settled: false, review_reference: ref('reply_draft') };
const snapshot = items => ({ ok: true, schema_version: 'home-inbox.v3', auto_settle_enabled: true, working_collapsed: true, limit: 1000, truncated: false, items });
test('a receipt refreshes exactly its card without returning unrelated canonical rows', async () => {
  const calls = [];
  const current = { ...row, source_version: 'v2', review_reference: { ...ref('reply_draft'), source_version: 'v2' } };
  const client = createInboxClient(async (name, args) => { calls.push({ name, args }); return name === 'read-home-inbox-v3' ? snapshot([{ ...row, item_id: 'unrelated', review_reference: null }, current]) : { ok: true, proposal_id: bound.proposal_id, version: 2 }; });
  const request = { verb: 'edit-email-draft', args: { ...bound, subject: 'Exact subject', body: 'Exact body', idempotency_key: crypto.randomUUID() } };
  const result = await client.review.run(parseItem(row, true), request);
  assert.equal(result.item.item_id, 'one'); assert.equal(result.item.source_version, 'v2');
  assert.deepEqual(calls.map(c => c.name), ['edit-email-draft', 'read-home-inbox-v3']); assert.deepEqual(calls[0].args, request.args);
});
test('wrong-identity receipts and missing readback never confirm another card', async () => {
  for (const receipt of [{ ok: true, proposal_id: 'wrong', version: 2 }, { ok: true, proposal_id: bound.proposal_id, version: 2 }]) {
    const client = createInboxClient(async name => name === 'read-home-inbox-v3' ? snapshot([]) : receipt);
    await assert.rejects(client.review.run(parseItem(row, true), { verb: 'dismiss-email-proposal', args: { ...bound, reason: 'Reviewed', idempotency_key: crypto.randomUUID() } }));
  }
});
test('malformed and mismatched references preserve the source card without inline controls', () => {
  for (const review_reference of [undefined, null, { ...ref('reply_draft'), item_id: 'other' }, { ...ref('reply_draft'), operations: ['delete-deal'] }]) assert.ok(!parseItem({ ...row, review_reference }, true).review_reference);
});
