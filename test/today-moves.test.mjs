import test from 'node:test';
import assert from 'node:assert/strict';
import { todayMoveSentence } from '../js/today-moves.mjs';

const move = (field, move_value) => ({ deal_name:'Riverside MOB', field, move_value, recorded_at:'2026-10-01T13:00:00Z' });
const now = Date.parse('2026-10-01T15:00:00Z');
for (const [field, value, expected] of [
  ['phase', 'due_diligence', 'Moved Riverside MOB to Due Diligence, 2 hours ago'],
  ['phase', 'Diligence', 'Moved Riverside MOB to Due Diligence, 2 hours ago'],
  ['owner', 'dell', 'Assigned Riverside MOB to Dell, 2 hours ago'],
  ['attention', true, 'Flagged Riverside MOB for attention, 2 hours ago'],
  ['attention', false, 'Cleared the attention flag for Riverside MOB, 2 hours ago'],
  ['next_step', 'Review terms', 'Updated the next step for Riverside MOB, 2 hours ago'],
  ['next_date', '2026-10-05', 'Updated the next date for Riverside MOB, 2 hours ago'],
  ['operating_state', {state:'parked'}, 'Paused work on Riverside MOB, 2 hours ago'],
  ['note', 'Synthetic note', 'Added a note to Riverside MOB, 2 hours ago'],
  ['checklist_ping', {recipient:'joe'}, 'Sent a reminder for Riverside MOB, 2 hours ago'],
  ['next_action', {description:'Call client'}, 'Updated a task for Riverside MOB, 2 hours ago'],
  ['client_id', {client_id:'secret'}, 'Updated the client for Riverside MOB, 2 hours ago'],
  ['document.sent_status', {sent_status:'draft'}, 'Updated a document for Riverside MOB, 2 hours ago'],
  ['operating_state', {state:'active'}, 'Resumed work on Riverside MOB, 2 hours ago'],
  ['deal_type', 'renewal', 'Updated the deal type for Riverside MOB, 2 hours ago'],
  ['segment', 'medical_office', 'Updated the segment for Riverside MOB, 2 hours ago'],
  ['outcome', 'won', 'Updated the outcome for Riverside MOB, 2 hours ago'],
  ['closed_on', '2026-10-05', 'Updated the closing date for Riverside MOB, 2 hours ago'],
  ['won_value', 100, 'Updated the value of Riverside MOB, 2 hours ago'],
  ['city', 'Example City', 'Updated the city for Riverside MOB, 2 hours ago'],
  ['lane', 'national', 'Updated the market for Riverside MOB, 2 hours ago'],
  ['invoiced_on', '2026-10-05', 'Updated the invoice date for Riverside MOB, 2 hours ago'],
  ['market_agent', 'Example Agent', 'Updated the market agent for Riverside MOB, 2 hours ago'],
  ['account_owner', 'joe', 'Updated the account owner for Riverside MOB, 2 hours ago'],
  ['status', 'open', 'Updated the status of Riverside MOB, 2 hours ago'],
  ['deal_items_conversion', {}, 'Updated deal items for Riverside MOB, 2 hours ago'],
  ['email_draft_metadata', {}, 'Updated an email draft for Riverside MOB, 2 hours ago'],
  ['call_change_undo', {}, 'Undid a call update for Riverside MOB, 2 hours ago'],
  ['summary', 'Example', 'Updated the summary for Riverside MOB, 2 hours ago'],
  ['description', 'Example', 'Updated the description for Riverside MOB, 2 hours ago'],
  ['document', {}, 'Updated a document for Riverside MOB, 2 hours ago'],
  ['unknown_internal_field', 'internal_value_123', 'Updated Riverside MOB, 2 hours ago'],
]) test(`Today describes ${field}`, () => assert.equal(todayMoveSentence(move(field,value), now), expected));
