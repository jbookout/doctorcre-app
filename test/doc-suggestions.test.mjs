import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFixtureClient } from '../js/fixture-client.js';
import {
  suggestionCards, decisionArgs, correctionArgs, shouldShowSuggestion,
  correctionConflict, suggestionFlow, suggestionReadState, visibleSuggestionConflicts,
  reconcileSuggestionConflicts,
} from '../js/doc-suggestions-model.js';

const first = {
  id: 'a0000000-0000-4000-8000-000000000001', obligation_key: 'lease:review',
  version: 3, material_version: 2, disposition: 'open',
  original_text: 'Review the lease by Friday, if it arrives.',
  polished_text: 'Review the lease by Friday if it arrives.',
  uncertainty: 'The lease has not arrived.', contributor: 'Joe',
  source_at: '2026-09-28T15:00:00Z', suggested_at: '2026-09-28T15:01:00Z',
  source_conversation_id: 'b0000000-0000-4000-8000-000000000001', source_sequence: 8,
  contributions: [{ original_text: 'Review the lease by Friday, if it arrives.', contributor: 'Joe', at: '2026-09-28T15:00:00Z' }],
};

test('distinct obligations stay separate even when polished words match', () => {
  const other = { ...first, id: 'a0000000-0000-4000-8000-000000000002', obligation_key: 'insurance:review' };
  const cards = suggestionCards({ suggestions: [first, other] });
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(card => card.obligationKey), ['lease:review', 'insurance:review']);
  assert.equal(cards[0].contributions[0].original, first.original_text);
  assert.equal(cards[0].uncertainty, first.uncertainty);
});

test('a dismissed or snoozed version stays hidden until material version changes', () => {
  assert.equal(shouldShowSuggestion({ ...first, disposition: 'dismissed', dismissed_material_version: 2 }), false);
  assert.equal(shouldShowSuggestion({ ...first, disposition: 'dismissed', dismissed_material_version: 2, material_version: 3 }), true);
  assert.equal(shouldShowSuggestion({ ...first, disposition: 'snoozed', snoozed_material_version: 2, snoozed_until: '2026-12-01' }, '2026-09-29'), false);
  assert.equal(shouldShowSuggestion({ ...first, disposition: 'snoozed', snoozed_material_version: 2, material_version: 3, snoozed_until: '2026-12-01' }, '2026-09-29'), true);
});

test('decisions bind one suggestion and its current version', () => {
  assert.deepEqual(decisionArgs(first, 'dismiss', 'c0000000-0000-4000-8000-000000000001'), {
    suggestion_id: first.id, base_version: 3, choice: 'dismiss',
    idempotency_key: 'c0000000-0000-4000-8000-000000000001',
  });
  assert.equal(decisionArgs(first, 'merge', 'key'), null);
});

test('a typed correction is a narrow proposal with source, never an overwrite', () => {
  const args = correctionArgs(first, 'The date should be Monday.', 'c0000000-0000-4000-8000-000000000002');
  assert.equal(args.suggestion_id, first.id);
  assert.equal(args.base_version, 3);
  assert.equal(args.proposed_text, 'The date should be Monday.');
  assert.equal(args.source_conversation_id, first.source_conversation_id);
  assert.equal(args.source_sequence, 8);
  assert.equal(correctionArgs(first, ' ', 'key'), null);
});

test('pending corrections remain visible beside the original suggestion after a read', async () => {
  const seed = await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8');
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString('base64')}` });
  const before = await client.listDocSuggestions();
  const target = before.suggestions[0];
  await client.proposeDocCorrection(correctionArgs(target, 'The lease review is due Monday.', 'c0000000-0000-4000-8000-000000000092'));
  const after = await client.listDocSuggestions();
  const card = suggestionCards(after).find(item => item.id === target.id);
  assert.equal(card.polished, target.polished_text);
  assert.equal(card.corrections.length, 1);
  assert.equal(card.corrections[0].proposedText, 'The lease review is due Monday.');
  assert.equal(card.corrections[0].status, 'pending');
});

test('version conflict retains the draft and exposes the current record', () => {
  const conflict = correctionConflict('The date should be Monday.', { ...first, version: 4, polished_text: 'Review on Tuesday.' });
  assert.equal(conflict.draft, 'The date should be Monday.');
  assert.equal(conflict.current.version, 4);
  assert.equal(conflict.current.polished, 'Review on Tuesday.');
  assert.equal(conflict.conversationId, first.source_conversation_id);
});

test('a failed or in-flight suggestion read clears old actionable rows while keeping typed drafts', () => {
  const held = { state: 'read', rows: [first], sequence: 4, includeParked: false,
    drafts: new Map([[first.id, 'Keep this correction']]), conflicts: new Map() };
  const loading = suggestionReadState(held, { state: 'loading' });
  assert.equal(loading.state, 'loading');
  assert.deepEqual(loading.rows, []);
  assert.equal(loading.drafts.get(first.id), 'Keep this correction');
  const failed = suggestionReadState(loading, { state: 'unavailable', sentence: 'Read unavailable.' });
  assert.deepEqual(failed.rows, []);
  assert.equal(failed.sentence, 'Read unavailable.');
  assert.equal(suggestionCards({ suggestions: failed.rows }).length, 0);
});

test('a conflict from another conversation does not hide this route’s empty state', () => {
  const conflict = correctionConflict('Review on Monday.', first);
  const conflicts = new Map([[first.id, conflict]]);
  assert.deepEqual(visibleSuggestionConflicts(conflicts, [], { state: 'ok', id: 'another-conversation' }), []);
  assert.equal(visibleSuggestionConflicts(conflicts, [], { state: 'ok', id: first.source_conversation_id }).length, 1);
  assert.deepEqual(visibleSuggestionConflicts(conflicts, [{ id: first.id }], { state: 'missing' }), []);
});

test('later reads refresh the current side of a conflict without losing the draft', () => {
  const held = new Map([[first.id, correctionConflict('Review on Monday.', first)]]);
  const newer = { ...first, version: 5, polished_text: 'Review on Wednesday.' };
  const refreshed = reconcileSuggestionConflicts(held, [newer]);
  assert.equal(refreshed.get(first.id).draft, 'Review on Monday.');
  assert.equal(refreshed.get(first.id).current.version, 5);
  assert.equal(refreshed.get(first.id).current.polished, 'Review on Wednesday.');
  assert.equal(held.get(first.id).current.version, 3);
  assert.equal(reconcileSuggestionConflicts(held, []).get(first.id).source, 'read', 'an omitted row is not invented');
});

test('a parked conflict remains comparable when the ordinary read omits it', async () => {
  const seed = await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8');
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString('base64')}` });
  const before = (await client.listDocSuggestions()).suggestions[0];
  await client.decideDocSuggestion(decisionArgs(before, 'dismiss', 'c0000000-0000-4000-8000-000000000093'));
  let current;
  await assert.rejects(() => client.proposeDocCorrection(correctionArgs(before, 'Review on Monday.', 'c0000000-0000-4000-8000-000000000094')),
    error => { current = error.payload?.current; return error.payload?.error === 'version_conflict'; });
  assert.equal((await client.listDocSuggestions()).suggestions.some(row => row.id === before.id), false);
  const conflict = correctionConflict('Review on Monday.', current);
  assert.equal(conflict.draft, 'Review on Monday.');
  assert.equal(conflict.current.version, before.version + 1);
  assert.equal(conflict.current.polished, before.polished_text);
  assert.equal((await client.listDocSuggestions({ include_parked: true })).suggestions.some(row => row.id === before.id), true);
});

test('the page gates suggestion controls on a successful read and keeps conflicts visible outside omitted rows', async () => {
  const page = await readFile(new URL('../js/conversations.js', import.meta.url), 'utf8');
  assert.match(page, /suggestionReadState\(view\.suggestions, \{ state: "loading" \}\)/);
  assert.match(page, /suggestionReadState\(view\.suggestions, \{ state: "unavailable", sentence: failure\.sentence \}\)/);
  assert.match(page, /state\.state === "read" \? suggestionCards/);
  assert.match(page, /view\.suggestions\.state !== "read"/);
  assert.match(page, /error\?\.payload\?\.current/);
  assert.match(page, /includeParked = true/);
  assert.match(page, /suggestion-conflict-only/);
});

test('visual flow names each decision and its outcome', () => {
  assert.deepEqual(suggestionFlow(first).map(stage => stage.label), ['Original', 'Suggestion', 'Your decision', 'Work or proposal']);
});

test('fixture keeps distinct obligations and replays the same decision without a second change', async () => {
  const seed = await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8');
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString('base64')}` });
  const before = await client.listDocSuggestions();
  assert.equal(before.suggestions.length, 2);
  assert.notEqual(before.suggestions[0].obligation_key, before.suggestions[1].obligation_key);
  assert.equal(before.suggestions[0].polished_text, before.suggestions[1].polished_text);
  const target = before.suggestions[0];
  const args = decisionArgs(target, 'dismiss', 'c0000000-0000-4000-8000-000000000091');
  const firstResult = await client.decideDocSuggestion(args);
  const replay = await client.decideDocSuggestion(args);
  assert.equal(replay.version, firstResult.version);
  assert.equal(replay.deduplicated, true);
  const after = await client.listDocSuggestions();
  assert.equal(after.suggestions.length, 1);
  assert.equal(after.suggestions[0].id, before.suggestions[1].id);
});
