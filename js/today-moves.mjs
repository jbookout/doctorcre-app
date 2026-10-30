import { ACTOR_LABEL, PHASE_BY_SLUG, phaseLabel } from './client.js';

// The one place a recorded change becomes words a broker would say. Every value
// passes through `say` or a closed map first, so an id, slug or object the feed
// carries can never reach the screen; when no safe value exists the sentence
// still says which part of the deal changed.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SLUG = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const UNSAFE = /[{}[\]<>]|\b[a-z]+(?:_[a-z0-9]+)+\b|\b[0-9a-f]{8}-[0-9a-f]{4}-|\binternal\b/i;
const TEXT_MAX = 60;
const WEEK_DAYS = 7;
const ACTORS = Object.freeze({ ...ACTOR_LABEL, doc: 'Doc' });
const MARKET = Object.freeze({ territory: 'Local', national: 'National' });
const STATUS = Object.freeze({ open: 'Open', closed: 'Closed', active: 'Active', inactive: 'Inactive', done: 'Done' });

const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);

/** A value a person can read, or null. Short slugs become words; free text is cut short. */
function say(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (SLUG.test(text) && !/\d/.test(text)) return capitalize(text.replace(/_/g, ' '));
  if (UNSAFE.test(text)) return null;
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;
}

/** The value itself, or the first readable text inside an object the feed wrapped it in. */
function pick(value, ...keys) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return keys.map(key => value[key]).find(item => typeof item === 'string' && item.trim()) ?? null;
  return value;
}

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) return null;
  const year = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric' }).format(new Date());
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}${value.slice(0, 4) === year ? '' : `, ${value.slice(0, 4)}`}`;
}

const set = (what, value) => value ? `Set the ${what} to ${value}` : `Changed the ${what}`;

const FIELDS = Object.freeze({
  phase: ({ value }) => {
    const phase = typeof value === 'string' ? (Object.hasOwn(PHASE_BY_SLUG, value) ? PHASE_BY_SLUG[value] : Object.values(PHASE_BY_SLUG).includes(value) ? value : null) : null;
    return phase ? `Moved to ${phaseLabel(phase)}` : 'Changed the phase';
  },
  owner: ({ value }) => typeof value === 'string' && Object.hasOwn(ACTOR_LABEL, value) ? `Assigned to ${ACTOR_LABEL[value]}` : 'Changed the owner',
  attention: ({ value }) => typeof value !== 'boolean' ? 'Changed the attention flag' : value ? 'Flagged for attention' : 'Cleared the attention flag',
  operating_state: ({ value }) => value?.state === 'parked' ? 'Paused work' : value?.state === 'active' ? 'Resumed work' : 'Changed whether work is active',
  next_step: ({ value }) => set('next step', say(pick(value, 'next_step'))),
  next_date: ({ value }) => set('next date', day(value)),
  closed_on: ({ value }) => set('closing date', day(value)),
  invoiced_on: ({ value }) => set('invoice date', day(value)),
  sf_close_date_placeholder: ({ value }) => set('close date', day(value)),
  note: ({ value }) => { const text = say(pick(value, 'note')); return text ? `Added a note: ${text}` : 'Added a note'; },
  checklist_ping: ({ value }) => {
    const who = Object.hasOwn(ACTOR_LABEL, value?.recipient) ? ACTOR_LABEL[value.recipient] : null;
    const due = day(value?.due_on);
    const critical = typeof value?.checklist_item_id === 'string' && value.checklist_item_id.startsWith('critical-date:');
    return `Sent ${who ?? 'a'} ${who ? 'a ' : ''}reminder${critical && due ? `: critical date due ${due}` : ''}`;
  },
  next_action: ({ value }) => {
    const text = say(pick(value, 'description', 'title'));
    if (!text) return 'Changed a task';
    const who = Object.hasOwn(ACTOR_LABEL, value?.assignee) ? ` for ${ACTOR_LABEL[value.assignee]}` : '';
    const due = day(value?.due_on);
    return `Set a task${who}: ${text}${due ? `, due ${due}` : ''}`;
  },
  client_id: ({ move }) => set('client', say(move.move_name)),
  document: () => 'Updated a document',
  'document.sent_status': ({ value }) => { const status = say(value?.sent_status); return status ? `Marked a document as ${status.toLowerCase()}` : 'Updated a document'; },
  deal_type: ({ value }) => set('deal type', say(value)),
  segment: ({ value }) => set('segment', say(value)),
  outcome: ({ value }) => set('outcome', say(value)),
  won_value: ({ value }) => set('won value', typeof value === 'number' && Number.isFinite(value) ? `$${value.toLocaleString('en-US')}` : null),
  city: ({ value }) => set('city', say(value)),
  lane: ({ value }) => set('market', typeof value === 'string' ? MARKET[value] ?? null : null),
  market_agent: ({ value }) => set('market agent', say(pick(value, 'market_agent'))),
  account_owner: ({ value }) => { const owner = pick(value, 'owner'); return set('account owner', Object.hasOwn(ACTOR_LABEL, owner) ? ACTOR_LABEL[owner] : null); },
  status: ({ value }) => { const status = pick(value, 'status'); return set('status', typeof status === 'string' ? STATUS[status] ?? null : null); },
  summary: ({ value }) => { const text = say(value); return text ? `Changed the summary to ${text}` : 'Changed the summary'; },
  description: ({ value }) => { const text = say(value); return text ? `Changed the description to ${text}` : 'Changed the description'; },
  deal_items_conversion: () => 'Updated deal items',
  email_draft_metadata: () => 'Updated an email draft',
  call_change_undo: () => 'Undid a call update',
});

/** Every field with its own wording. The copy check exercises each one. */
export const MOVE_FIELDS = Object.freeze(Object.keys(FIELDS));

function age(recordedAt, now) {
  const instant = typeof recordedAt === 'string' ? Date.parse(recordedAt) : NaN;
  if (!Number.isFinite(instant)) return null;
  const minutes = Math.max(0, Math.floor((now - instant) / 60_000));
  const count = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return count(minutes, 'minute');
  if (minutes < 1440) return count(Math.floor(minutes / 60), 'hour');
  if (minutes < WEEK_DAYS * 1440) return count(Math.floor(minutes / 1440), 'day');
  const options = { timeZone: 'America/Chicago', month: 'short', day: 'numeric' };
  const sameYear = new Date(instant).getUTCFullYear() === new Date(now).getUTCFullYear();
  return new Intl.DateTimeFormat('en-US', sameYear ? options : { ...options, year: 'numeric' }).format(instant);
}

/**
 * One recorded change as its parts: the deal, what happened, who did it, and
 * how long ago. `age` is relative to `now`, so a list that shows it must
 * re-render on a clock tick; surfaces that render only on change show the
 * action alone.
 */
export function todayMove(move, now = Date.now()) {
  const wording = Object.hasOwn(FIELDS, move.field) ? FIELDS[move.field] : null;
  return {
    name: move.deal_name,
    action: wording ? wording({ value: move.move_value, move }) : 'Updated the deal',
    by: typeof move.actor === 'string' && Object.hasOwn(ACTORS, move.actor) ? ACTORS[move.actor] : null,
    age: age(move.recorded_at, now),
  };
}
