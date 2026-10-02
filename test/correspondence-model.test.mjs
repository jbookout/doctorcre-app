import test from 'node:test';
import assert from 'node:assert/strict';
import { readinessRequest, threadRequest, readinessState, correspondenceState, meetingEvidence, threadReferences } from '../js/correspondence-model.js';
import { identity, found, receipt, unavailable, readiness, meeting } from './fixtures/correspondence.mjs';
const clone = value => structuredClone(value);

test('read requests reject unknown or missing keys; no actor or deal is invented', () => {
  assert.deepEqual(readinessRequest({}), {});
  assert.throws(() => readinessRequest({ deal: 'demo-deal' }));
  assert.deepEqual(threadRequest(identity), identity);
  for (const key of Object.keys(identity)) { const args = clone(identity); delete args[key]; assert.throws(() => threadRequest(args)); }
  assert.throws(() => threadRequest({ ...identity, actor: 'demo-partner' }));
  for (const epoch of [-1, '0', 1.5]) assert.throws(() => threadRequest({ ...identity, native_id_epoch: epoch }));
});

test('unavailable, refused, unanswered and error responses never become zero', () => {
  for (const answer of [unavailable, null, undefined, new Error('demo'), { ok: false, error: 'refused' }, { decision: 'refuse' }]) {
    const state = correspondenceState(answer, identity);
    assert.equal(state.state, 'unavailable'); assert.equal(state.count, null); assert.deepEqual(state.items, []);
  }
  assert.equal(correspondenceState({ ...found, receipts: [] }, identity).state, 'unavailable');
});

test('thread payloads reject every missing top-level key and unknown keys', () => {
  for (const answer of [found, unavailable]) {
    for (const key of Object.keys(answer)) { const bad = clone(answer); delete bad[key]; assert.equal(correspondenceState(bad, identity).state, 'unavailable', key); }
    assert.equal(correspondenceState({ ...answer, unknown: true }, identity).state, 'unavailable');
  }
});

test('receipts and native identities require exact keys and matching provenance', () => {
  for (const key of Object.keys(receipt)) { const bad = clone(found); delete bad.receipts[0][key]; assert.equal(correspondenceState(bad, identity).state, 'unavailable', key); }
  const variants = [ { ...receipt, unknown: true }, { ...receipt, consent_in_force: false },
    { ...receipt, native_identity: { ...identity, native_id: 'demo-other-thread' } },
    { ...receipt, native_identity: { ...identity, extra: true } }, { ...receipt, recorded_at: 'unknown' } ];
  for (const row of variants) assert.equal(correspondenceState({ ...found, receipts: [row] }, identity).state, 'unavailable');
});

test('readiness counts are installation facts and never deal evidence counts', () => {
  const state = readinessState(readiness);
  assert.equal(state.state, 'unavailable'); assert.equal(state.reason, 'adapter_unavailable'); assert.equal(state.count, null);
  assert.equal(readinessState({ ...readiness, mailbox_reads_possible: true,
    readiness: { ...readiness.readiness, read_receipt_writer_granted_to_runtime: true } }).state, 'ready');
  for (const key of Object.keys(readiness)) { const bad = clone(readiness); delete bad[key]; assert.equal(readinessState(bad).state, 'unavailable', key); }
  for (const bad of [null, { ...readiness, unknown: true }, { ...readiness, readiness: { ...readiness.readiness, extra: true } }]) {
    assert.equal(readinessState(bad).state, 'unavailable'); assert.equal(readinessState(bad).count, null);
  }
});

test('every correspondence and meeting item has a source label', () => {
  const threads = correspondenceState(found, identity);
  assert.equal(threads.state, 'ready'); assert.equal(threads.count, 1);
  assert.match(threads.items[0].source, /demo-mail/); assert.match(threads.items[0].source, /demo-partner/);
  const meetings = meetingEvidence([meeting]);
  assert.equal(meetings.state, 'ready'); assert.equal(meetings.items[0].source, 'Demo calendar fixture · CARR deal activity');
  assert.equal(meetingEvidence([{ ...meeting, source: null }]).state, 'unavailable');
  assert.equal(meetingEvidence([]).count, null);
});

test('native thread references come only from recorded activity provenance, never a name or deal id', () => {
  assert.deepEqual(threadReferences({ deal: { id: 'demo-deal' }, thread: [{ id: 'demo-note' }] }), { references: [], complete: true });
  assert.deepEqual(threadReferences({ activities: [{ ...meeting, detail: { native_identity: identity } }] }), { references: [identity], complete: true });
  assert.deepEqual(threadReferences({ activities: [{ ...meeting, detail: { native_identity: { ...identity, extra: 'demo' } } }] }), { references: [], complete: false });
});
