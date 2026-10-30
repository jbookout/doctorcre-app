import { ACTOR_LABEL, PHASE_BY_SLUG, phaseLabel } from './client.js';

const descriptions = Object.freeze({
  next_step: 'Updated the next step for', next_date: 'Updated the next date for',
  note: 'Added a note to', checklist_ping: 'Sent a reminder for',
  next_action: 'Updated a task for', client_id: 'Updated the client for',
  document: 'Updated a document for', 'document.sent_status': 'Updated a document for',
  deal_type: 'Updated the deal type for', segment: 'Updated the segment for',
  outcome: 'Updated the outcome for', closed_on: 'Updated the closing date for',
  won_value: 'Updated the value of', city: 'Updated the city for', lane: 'Updated the market for',
  invoiced_on: 'Updated the invoice date for', market_agent: 'Updated the market agent for',
  account_owner: 'Updated the account owner for', status: 'Updated the status of',
  deal_items_conversion: 'Updated deal items for', email_draft_metadata: 'Updated an email draft for',
  call_change_undo: 'Undid a call update for', summary: 'Updated the summary for',
  description: 'Updated the description for',
});

export function todayMoveSentence(move, now = Date.now()) {
  const name = move.deal_name;
  const value = move.move_value;
  let sentence;
  if (move.field === 'phase' && typeof value === 'string' && (Object.hasOwn(PHASE_BY_SLUG, value) || Object.values(PHASE_BY_SLUG).includes(value))) {
    sentence = `Moved ${name} to ${phaseLabel(PHASE_BY_SLUG[value] || value)}`;
  } else if (move.field === 'owner' && typeof value === 'string' && Object.hasOwn(ACTOR_LABEL, value)) {
    sentence = `Assigned ${name} to ${ACTOR_LABEL[value]}`;
  } else if (move.field === 'attention' && typeof value === 'boolean') {
    sentence = value ? `Flagged ${name} for attention` : `Cleared the attention flag for ${name}`;
  } else if (move.field === 'operating_state' && value?.state === 'parked') {
    sentence = `Paused work on ${name}`;
  } else if (move.field === 'operating_state' && value?.state === 'active') {
    sentence = `Resumed work on ${name}`;
  } else {
    sentence = `${Object.hasOwn(descriptions, move.field) ? descriptions[move.field] : 'Updated'} ${name}`;
  }
  const instant = Date.parse(move.recorded_at || '');
  if (!Number.isFinite(instant)) return `${sentence}, time not recorded`;
  const minutes = Math.max(0, Math.floor((now - instant) / 60000));
  const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} ${minutes < 120 ? 'hour' : 'hours'} ago` : `${Math.floor(minutes / 1440)} ${minutes < 2880 ? 'day' : 'days'} ago`;
  return `${sentence}, ${age}`;
}
