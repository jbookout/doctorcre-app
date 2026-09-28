import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftBoardReadiness, createLocalDrafts } from '../js/local-drafts.mjs';

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
  readiness.complete(first, 'joe');
  assert.equal(readiness.canFile('joe', true), true);
  readiness.begin();
  assert.equal(readiness.canFile('joe', true), false);
  assert.deepEqual(saved.list(), original);
});

test('only the current successful board read for this viewer unlocks the restored draft', () => {
  const readiness = createDraftBoardReadiness();
  const stale = readiness.begin();
  const current = readiness.begin();
  assert.equal(readiness.complete(stale, 'joe'), false);
  assert.equal(readiness.canFile('joe', true), false);
  assert.equal(readiness.complete(current, 'joe'), true);
  assert.equal(readiness.canFile('joe', true), true);
});

test('failed read, offline transition and viewer switch cannot borrow a prior board', () => {
  const readiness = createDraftBoardReadiness();
  const joeRead = readiness.begin();
  readiness.complete(joeRead, 'joe');
  assert.equal(readiness.canFile('dell', true), false);
  readiness.invalidate();
  assert.equal(readiness.canFile('joe', false), false);
  assert.equal(readiness.complete(joeRead, 'joe'), false);
  const failed = readiness.begin();
  assert.equal(readiness.current(failed), true);
  assert.equal(readiness.canFile('joe', true), false);
});
