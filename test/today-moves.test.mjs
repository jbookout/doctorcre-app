import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVE_FIELDS, todayMove } from '../js/today-moves.mjs';
import { receiptsAnnouncement } from '../js/change-receipts.mjs';
import * as receipts from '../js/change-receipts.mjs';

const now = Date.parse('2026-10-01T15:00:00Z');
const ago = ms => new Date(now - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const move = (field, move_value, extra = {}) => ({ deal_name:'Riverside MOB', field, move_value, actor:'joe', recorded_at:ago(2 * HOUR), ...extra });

for (const [field, value, expected] of [
  ['phase', 'due_diligence', 'Moved to Due Diligence'],
  ['phase', 'Diligence', 'Moved to Due Diligence'],
  ['phase', 'internal_value_123', 'Changed the phase'],
  ['owner', 'dell', 'Assigned to Dell'],
  ['owner', 'internal_value_123', 'Changed the owner'],
  ['attention', true, 'Flagged for attention'],
  ['attention', false, 'Cleared the attention flag'],
  ['operating_state', { state:'parked' }, 'Paused work'],
  ['operating_state', { state:'active' }, 'Resumed work'],
  ['next_step', 'Review terms', 'Set the next step to Review terms'],
  ['next_step', 'internal_value_123', 'Changed the next step'],
  ['next_date', '2026-10-05', 'Set the next date to Oct 5'],
  ['next_date', 'not a date', 'Changed the next date'],
  ['closed_on', '2026-10-05', 'Set the closing date to Oct 5'],
  ['invoiced_on', '2026-10-05', 'Set the invoice date to Oct 5'],
  ['note', 'Call the client Friday', 'Added a note: Call the client Friday'],
  ['note', { note:'Synthetic note' }, 'Added a note: Synthetic note'],
  ['note', { id:'abc' }, 'Added a note'],
  ['checklist_ping', { recipient:'dell', due_on:'2026-08-20', checklist_item_id:'critical-date:0558' }, 'Sent Dell a reminder: critical date due Aug 20'],
  ['checklist_ping', { recipient:'internal_value_123' }, 'Sent a reminder'],
  ['next_action', { description:'Call the client', assignee:'joe', due_on:'2026-10-05' }, 'Set a task for Joe: Call the client, due Oct 5'],
  ['next_action', { next_action_id:'critical-date:0558' }, 'Changed a task'],
  ['client_id', { client_id:'0558aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, 'Changed the client'],
  ['document', { template:'internal', document_id:'abc' }, 'Updated a document'],
  ['document.sent_status', { sent_status:'draft' }, 'Marked a document as draft'],
  ['document.sent_status', { sent_status:'internal_value_123' }, 'Updated a document'],
  ['deal_type', 'renewal', 'Set the deal type to Renewal'],
  ['segment', 'medical_office', 'Set the segment to Medical office'],
  ['outcome', 'won', 'Set the outcome to Won'],
  ['won_value', 100, 'Set the won value to $100'],
  ['city', 'Example City', 'Set the city to Example City'],
  ['lane', 'territory', 'Set the market to Local'],
  ['market_agent', { market_agent:'Example Agent' }, 'Set the market agent to Example Agent'],
  ['account_owner', { owner:'joe' }, 'Set the account owner to Joe'],
  ['status', 'open', 'Set the status to Open'],
  ['status', { status:'done' }, 'Set the status to Done'],
  ['summary', 'Example summary', 'Changed the summary to Example summary'],
  ['description', 'Example description', 'Changed the description to Example description'],
  ['deal_items_conversion', {}, 'Updated deal items'],
  ['email_draft_metadata', {}, 'Updated an email draft'],
  ['call_change_undo', {}, 'Undid a call update'],
  ['notes_path', 'internal:key', 'Updated the deal'],
  ['salesforce_id', 'abc123', 'Updated the deal'],
  ['unknown_internal_field', 'internal_value_123', 'Updated the deal'],
]) test(`Today says what changed for ${field}: ${JSON.stringify(value)}`, () => assert.equal(todayMove(move(field, value), now).action, expected));

test('client name is shown when the feed supplies it', () => {
  assert.equal(todayMove(move('client_id', { client_id:'x' }, { move_name:'Synthetic Client' }), now).action, 'Set the client to Synthetic Client');
});

test('long free text is cut short', () => {
  const { action } = todayMove(move('next_step', 'Review '.repeat(30)), now);
  assert.ok(action.length < 90 && action.endsWith('…'), action);
});

test('actor attribution tells an automated move from a person', () => {
  assert.equal(todayMove(move('attention', true, { actor:'doc' }), now).by, 'Doc');
  assert.equal(todayMove(move('attention', true, { actor:'dell' }), now).by, 'Dell');
  assert.equal(todayMove(move('attention', true, { actor:'joe' }), now).by, 'Joe');
  assert.equal(todayMove(move('attention', true, { actor:null }), now).by, null);
  assert.equal(todayMove(move('attention', true, { actor:'internal_value_123' }), now).by, null);
});

for (const [label, offset, expected] of [
  ['under a minute', 20_000, 'just now'],
  ['a clock a little ahead', -30_000, 'just now'],
  ['one minute', MIN, '1 minute ago'],
  ['several minutes', 7 * MIN, '7 minutes ago'],
  ['59 minutes', 59 * MIN, '59 minutes ago'],
  ['one hour', HOUR, '1 hour ago'],
  ['several hours', 5 * HOUR + 40 * MIN, '5 hours ago'],
  ['one day', DAY, '1 day ago'],
  ['several days', 3 * DAY, '3 days ago'],
  ['six days', 6 * DAY, '6 days ago'],
  ['a week', 7 * DAY, 'Sep 24'],
  ['very old, same year', 90 * DAY, 'Jul 3'],
  ['very old, earlier year', 400 * DAY, 'Aug 27, 2025'],
]) test(`age reads ${expected} for ${label}`, () => assert.equal(todayMove(move('attention', true, { recorded_at:ago(offset) }), now).age, expected));

for (const recorded_at of [null, undefined, '', 'not a time', 12345]) test(`a move with time ${JSON.stringify(recorded_at)} has no age, not a placeholder`, () => {
  assert.equal(todayMove(move('attention', true, { recorded_at }), now).age, null);
});

test('the same move reads younger or older as the clock advances', () => {
  const m = move('attention', true, { recorded_at:ago(30_000) });
  assert.equal(todayMove(m, now).age, 'just now');
  assert.equal(todayMove(m, now + 5 * MIN).age, '5 minutes ago');
  assert.equal(todayMove(m, now + 3 * HOUR).age, '3 hours ago');
});

test('every described field is free of internal terms for any value', () => {
  const bad = /internal|_|[{}]|[0-9a-f]{8}-[0-9a-f]{4}|123|abc/i;
  for (const field of MOVE_FIELDS) for (const value of ['internal_value_123', { internal_key:'internal_value_123', id:'abc' }, 7, true, null]) {
    const { action } = todayMove(move(field, value), now);
    assert.doesNotMatch(action, bad, `${field}: ${action}`);
  }
});

test('the announcement uses the same plain wording as the Today list', () => {
  const view = { event_id:'e1', deal_name:'Riverside MOB', field:'phase', move_value:'due_diligence', actor:'dell' };
  assert.equal(receiptsAnnouncement([], [view]), '1 new change · Riverside MOB · Moved to Due Diligence');
  assert.doesNotMatch(receiptsAnnouncement([], [view]), /→/);
  assert.equal(receipts.moveSentence, undefined, 'the old formatter is gone');
});
