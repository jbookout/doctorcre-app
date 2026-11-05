import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDrafts, matchingDraftId } from '../js/local-drafts.mjs';
import { createLiveClient } from '../js/live-client.js';
import { classifyCommandOutcome, commandMessage, performCommand } from '../js/command-feedback.mjs';
import { classifyUndoOutcome } from '../js/change-receipts.mjs';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    values: () => [...data.values()],
  };
}

test('a local draft restores exact sentence and date for its viewer without storing a request', () => {
  const storage = memoryStorage();
  const joe = createLocalDrafts({ storage, viewer: 'joe', now: () => 17, newId: () => 'local-1' });
  joe.save('  Call Dr. Patel Friday 10 AM  ', '2026-09-25');
  const restored = createLocalDrafts({ storage, viewer: 'joe' }).list();
  assert.deepEqual(restored, [{ id: 'local-1', sentence: '  Call Dr. Patel Friday 10 AM  ', dueDate: '2026-09-25', savedAt: 17 }]);
  assert.deepEqual(createLocalDrafts({ storage, viewer: 'dell' }).list(), []);
  assert.doesNotMatch(storage.values()[0], /idempotency_key|base_version|lifecycle/);
  assert.equal(matchingDraftId(restored, 'local-1', '  Call Dr. Patel Friday 10 AM  ', '2026-09-25'), 'local-1');
  assert.equal(matchingDraftId(restored, 'local-1', 'Call someone else', '2026-09-25'), null);
  assert.equal(matchingDraftId(restored, 'local-1', '  Call Dr. Patel Friday 10 AM  ', '2026-09-26'), null);
  joe.remove('local-1');
  assert.deepEqual(createLocalDrafts({ storage, viewer: 'joe' }).list(), []);
});

test('unavailable and corrupt browser storage keep drafts in page memory', () => {
  const broken = { getItem: () => '{bad', setItem: () => { throw new Error('quota'); } };
  const drafts = createLocalDrafts({ storage: broken, viewer: 'joe', newId: () => 'local-2' });
  assert.equal(drafts.isPersisted(), false);
  drafts.save('Call the CPA', '');
  assert.deepEqual(drafts.list().map((draft) => draft.sentence), ['Call the CPA']);
  assert.equal(drafts.isPersisted(), false);
});

test('one malformed draft does not discard valid saved drafts', () => {
  const storage = memoryStorage();
  const seed = createLocalDrafts({ storage, viewer: 'joe', newId: () => 'valid', now: () => 17 });
  seed.save('Call the CPA', '');
  const original = JSON.parse(storage.values()[0]);
  storage.setItem('doctorcre:quick-add-drafts:v1:joe', JSON.stringify([...original, { bad: true }]));
  const restored = createLocalDrafts({ storage, viewer: 'joe', newId: () => 'second', now: () => 18 });
  restored.save('Send the LOI', '');
  assert.deepEqual(createLocalDrafts({ storage, viewer: 'joe' }).list().map((draft) => draft.sentence), ['Call the CPA', 'Send the LOI']);
});

test('offline live writes send no request and stay unconfirmed', async () => {
  let calls = 0;
  const client = createLiveClient({ online: () => false, fetchImpl: async () => { calls += 1; throw new Error('sent'); } });
  await assert.rejects(client.addLoop({ title: 'Call the CPA', idempotency_key: 'same-key' }), (error) => {
    assert.equal(error.payload.error, 'offline');
    assert.equal(classifyCommandOutcome({ error }).status, 'unknown');
    assert.match(commandMessage(classifyCommandOutcome({ error })), /was not sent/);
    assert.match(classifyUndoOutcome({ error }).message, /was not sent/);
    return true;
  });
  assert.equal(calls, 0);

  let state = {};
  const result = await performCommand({
    operationKey: 'quickadd:offline', args: { title: 'Call the CPA' },
    getState: () => state, setState: (next) => { state = next; },
    newKey: () => 'same-key', call: (request) => client.addLoop(request),
  });
  assert.equal(result.sent, false);
  assert.equal(result.status, 'unknown');
  assert.equal(result.request.idempotency_key, 'same-key');
  assert.equal(calls, 0);
});

test('Gregorian dates reject new impossible values without changing existing drafts', () => {
  const drafts = createLocalDrafts({ storage: memoryStorage(), viewer: 'joe' });
  for (const date of ['', '0001-01-01', '9999-12-31', '2024-02-29', '2000-02-29']) assert.ok(drafts.save('Call lender', date));
  const before = drafts.list();
  for (const date of ['2026-02-31', '2026-13-01', '0000-01-01', '1900-02-29', '2026-02-29', '2026-04-31']) {
    assert.equal(drafts.save('Call lender', date), null, date);
    assert.deepEqual(drafts.list(), before);
  }
});

test('stored invalid dates preserve exact text and raw date with a review disposition', () => {
  const storage = memoryStorage();
  const values = ['2026-02-31', '2026-13-01', '0000-01-01', 'not-a-date'];
  storage.setItem('doctorcre:quick-add-drafts:v1:joe', JSON.stringify(values.map((dueDate, i) => ({ id: String(i), sentence: '  Call lender  ', dueDate, savedAt: 17 }))));
  const drafts = createLocalDrafts({ storage, viewer: 'joe' });
  assert.deepEqual(drafts.list().map(d => [d.sentence, d.dueDate, d.dateReviewRequired]), values.map(d => ['  Call lender  ', d, true]));
  assert.equal(drafts.remove('0'), true);
  assert.equal(drafts.remove('0'), false);
  for (let i = 0; i < 40; i++) drafts.save('Next call');
  assert.equal(drafts.list().length, 30);
});
