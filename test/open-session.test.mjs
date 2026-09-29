import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionOpenTarget, outcomeOpenTarget, reconcileOpenAttempt, reconcileOutcomeOpenAttempt,
} from '../js/open-session-model.js';

const nativeId = '11111111-1111-4111-8111-111111111111';
const session = {
  canonical_session_id: nativeId, surface: 'codex', native_host_id: nativeId,
  native_host_supported: true,
};

test('a verified Codex target opens the same native thread twice without a launch request', () => {
  const first = sessionOpenTarget(session, { hostAvailable: true });
  const second = sessionOpenTarget(session, { hostAvailable: true });
  assert.equal(first.href, `codex://threads/${nativeId}`);
  assert.deepEqual(second, first);
  assert.deepEqual(first.rights, { open: true, message: false, takeover: false });
  assert.equal(first.autoLaunch, false);
});

test('unsupported, unavailable, and mismatched session targets retain the copy-ID fallback', () => {
  for (const row of [
    { ...session, surface: 'claude' },
    { ...session, native_host_supported: false },
    { ...session, native_host_id: '22222222-2222-4222-8222-222222222222' },
  ]) {
    const target = sessionOpenTarget(row, { hostAvailable: true });
    assert.equal(target.open, false);
    assert.equal(target.href, null);
    assert.equal(target.copyId, nativeId);
  }
  assert.equal(sessionOpenTarget(session, { hostAvailable: false }).open, false);
});

test('outcome cards require an authorized canonical-to-native binding before Open appears', () => {
  const card = {
    canonical_session_id: { value: 'capability-session-1' },
    native_task_id: { value: nativeId },
    session_entry: { available: true, capability: 'codex_desktop_open_v1',
      target: nativeId, auto_launch: false },
  };
  assert.equal(outcomeOpenTarget(card, { hostAvailable: true }).href, `codex://threads/${nativeId}`);
  assert.equal(outcomeOpenTarget({ ...card, session_entry: { ...card.session_entry, target: 'wrong' } },
    { hostAvailable: true }).open, false);
  assert.equal(outcomeOpenTarget({ ...card, session_entry: { ...card.session_entry, auto_launch: true } },
    { hostAvailable: true }).open, false);
  assert.equal(outcomeOpenTarget({ ...card, native_task_id: { value: null } },
    { hostAvailable: true }).open, false);
});

test('a lost open response is reconciled by a fresh exact read, never by an automatic launch', () => {
  const target = sessionOpenTarget(session, { hostAvailable: true });
  const fresh = { ok: true, sessions: [session] };
  const outcome = reconcileOpenAttempt(target, fresh, { hostAvailable: true });
  assert.equal(outcome.state, 'same_target_unconfirmed');
  assert.equal(outcome.href, target.href);
  assert.equal(outcome.autoRetry, false);
  const changed = reconcileOpenAttempt(target, { ok: true, sessions: [{ ...session,
    native_host_id: '22222222-2222-4222-8222-222222222222' }] }, { hostAvailable: true });
  assert.equal(changed.state, 'target_changed');
  assert.equal(changed.href, null);
});

test('outcome handoff reconciliation keeps the same native target and never retries itself', () => {
  const card = { card_id: 'card:doc-outcome:one', canonical_session_id: { value: 'capability-session-1' },
    native_task_id: { value: nativeId }, session_entry: { available: true,
      capability: 'codex_desktop_open_v1', target: nativeId, auto_launch: false } };
  const prior = outcomeOpenTarget(card, { hostAvailable: true });
  const fresh = reconcileOutcomeOpenAttempt(prior, card, { hostAvailable: true });
  assert.deepEqual(fresh, { state: 'same_target_unconfirmed', href: prior.href, autoRetry: false });
  assert.equal(reconcileOutcomeOpenAttempt(prior, { ...card, native_task_id: { value: null } },
    { hostAvailable: true }).state, 'target_changed');
});
