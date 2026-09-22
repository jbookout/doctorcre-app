import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDrafts, matchingDraftId } from '../js/local-drafts.mjs';
import { createLiveClient } from '../js/live-client.js';
import { classifyCommandOutcome, commandMessage, createCommandState, performCommand } from '../js/command-feedback.mjs';
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

  let state = createCommandState();
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
