// The words for one change a pipeline call made: shared by the applied list
// (call-outcomes.js) and Call Mode's deal cards. Kept apart so Call Mode,
// which loads with every Deals page, does not carry the list until a call
// has outcomes to show.
import { PHASE_BY_SLUG } from './client.js';

/** A calendar day in the app's own short style ("Nov 3"); the raw value when it is not a date. */
export function dayLabel(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/u.test(value)) return String(value ?? '');
  const at = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function callChangeText(change) {
  const payload = change?.payload || {};
  if (change?.kind === 'phase_move') {
    const phase = PHASE_BY_SLUG[payload.value] || payload.value || 'a new phase';
    return `Phase moved to ${phase}${payload.started_on ? `, started ${dayLabel(payload.started_on)}` : ''}`;
  }
  if (change?.kind === 'next_step') return `Next step: ${payload.text || ''}${payload.next_date ? ` · due ${dayLabel(payload.next_date)}` : ''}`;
  return 'Change applied from the call';
}
