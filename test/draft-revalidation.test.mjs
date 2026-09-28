import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftBoardReadiness, createLocalDrafts } from '../js/local-drafts.mjs';
import { parseQuickAdd } from '../js/visual-system.js';
import { quickAddPlan, quickAddRecords } from '../js/task-records-model.js';
import { createLiveClient } from '../js/live-client.js';

const board = (actor = 'joe') => ({ actor, deals: [{ id: 'deal-1', name: 'Demo Gulf Breeze Dental' }], accounts: [] });

function storage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
}

test('a restored draft stays unsent while reconnect board revalidation is pending', () => {
  const saved = createLocalDrafts({ storage: storage(), viewer: 'joe', newId: () => 'draft-1', now: () => 7 });
  saved.save('  Call the client after the tour  ', '');
  const original = saved.list();
  const readiness = createDraftBoardReadiness();
  const first = readiness.begin();
  readiness.complete(first, board());
  assert.equal(readiness.canFile('joe', true), true);
  readiness.begin();
  assert.equal(readiness.canFile('joe', true), false);
  assert.deepEqual(saved.list(), original);
});

test('only the current successful board read for this viewer unlocks the restored draft', () => {
  const readiness = createDraftBoardReadiness();
  const stale = readiness.begin();
  const current = readiness.begin();
  assert.equal(readiness.complete(stale, board()), false);
  assert.equal(readiness.canFile('joe', true), false);
  assert.equal(readiness.complete(current, board()), true);
  assert.equal(readiness.canFile('joe', true), true);
});

test('failed read, offline transition and viewer switch cannot borrow a prior board', () => {
  const readiness = createDraftBoardReadiness();
  const joeRead = readiness.begin();
  readiness.complete(joeRead, board());
  assert.equal(readiness.canFile('dell', true), false);
  readiness.invalidate();
  assert.equal(readiness.canFile('joe', false), false);
  assert.equal(readiness.complete(joeRead, board()), false);
  const failed = readiness.begin();
  assert.equal(readiness.current(failed), true);
  assert.equal(readiness.canFile('joe', true), false);
});

test('actor-only and malformed board answers cannot unlock a draft', () => {
  const readiness = createDraftBoardReadiness();
  for (const malformed of [{ actor: 'joe' }, { actor: 'joe', deals: null, accounts: [] }, { actor: 'joe', deals: [], accounts: null }]) {
    const token = readiness.begin();
    assert.equal(readiness.complete(token, malformed), false);
    assert.equal(readiness.canFile('joe', true), false);
  }
  const token = readiness.begin();
  assert.equal(readiness.complete(token, board()), true);
  assert.equal(readiness.canFile('joe', true), true);
});

test('the live adapter preserves an actor-only malformed answer for validation', async () => {
  const client = createLiveClient({ fetchImpl: async () => new Response(JSON.stringify({
    result: { content: [{ text: JSON.stringify({ actor: 'joe' }) }] },
  }), { status: 200 }) });
  const malformed = await client.getBoard();
  assert.equal(Object.hasOwn(malformed, 'deals'), true);
  assert.equal(malformed.deals, undefined);
  const readiness = createDraftBoardReadiness();
  assert.equal(readiness.complete(readiness.begin(), malformed), false);
});

test('a failed read can be retried without changing the draft, and only the retry unlocks filing', () => {
  const saved = createLocalDrafts({ storage: storage(), viewer: 'joe', newId: () => 'draft-1', now: () => 7 });
  saved.save('  Call the client after the tour  ');
  const before = saved.list();
  const readiness = createDraftBoardReadiness();
  const failed = readiness.begin();
  assert.equal(readiness.complete(failed, null), false);
  assert.equal(readiness.canFile('joe', true), false);
  const retry = readiness.begin();
  assert.equal(readiness.complete(failed, board()), false);
  assert.equal(readiness.complete(retry, board()), true);
  assert.equal(readiness.canFile('joe', true), true);
  assert.deepEqual(saved.list(), before);
});

test('a new sentence waits for revalidation so its related source note survives', () => {
  const readiness = createDraftBoardReadiness();
  const sentence = 'Call about Demo Gulf Breeze Dental friday';
  const parsed = (records) => parseQuickAdd(sentence, { now: Date.parse('2026-09-16T14:00:00Z'), viewer: 'joe', records });
  const missing = quickAddPlan(parsed([]), { viewer: 'joe', sentence });
  const verified = quickAddPlan(parsed(quickAddRecords(board().deals)), { viewer: 'joe', sentence });
  assert.equal(missing.args?.source_note, undefined);
  assert.match(verified.args?.source_note || '', /Demo Gulf Breeze Dental/);
  const token = readiness.begin();
  assert.equal(readiness.canFile('joe', true), false);
  assert.equal(readiness.complete(token, board()), true);
  assert.equal(readiness.canFile('joe', true), true);
});
