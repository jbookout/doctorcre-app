// Doc's morning brief. Pure: the view hands in live reads and app-only memory
// of when the brief was last shown; this returns what to show and say.
import { scopedDeals, dealHref } from './home-dashboard-model.js';
import { localToday, toDay } from './calendar-model.js';
import { normalizeChangeEvent, compareReceipts } from './change-receipts.mjs';
import { ACTOR_LABEL } from './client.js';

export const BRIEF_LIMIT = 3;
const SPOKEN_WORDS = 75;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dayLabel = day => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const clock = at => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
// The pinned today-triage producer returns the oldest 50 global rows.
// Reaching that cap cannot establish completeness for any partner.
const TRIAGE_CAP = 50;
const row = value => value && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.trim().length > 0;
const instant = value => typeof value === 'string' && toDay(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const validTriage = items => Array.isArray(items) && items.every(item => row(item)
  && identity(item.subject_type) && identity(item.subject_id)
  && (item.owner == null || identity(item.owner)) && (item.what == null || typeof item.what === 'string')
  && (item.subject_type !== 'deal' || Boolean(toDay(item.due_on))));

// Shared by composition and feed paging: unreadable rows must not advance a
// cursor and disappear before the model can report an unavailable section.
export const validBriefEvents = events => Array.isArray(events) && events.every(event => row(event)
  && identity(event.id) && identity(event.subject_type) && identity(event.subject_id)
  && instant(event.recorded_at) && (event.actor == null || identity(event.actor)));

/**
 * Once per local day. A new day's overnight window starts where the last
 * brief was shown; the first ever brief starts at 6 PM the previous evening.
 * Reopening the same day keeps the same window.
 */
export function briefWindow(stored, now = new Date()) {
  const day = localToday(now);
  if (stored?.day === day && instant(stored.since) && instant(stored.shownAt)) return { due: false, since: stored.since, record: stored };
  const evening = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 18).toISOString();
  const since = typeof stored?.shownAt === 'string' && Number.isFinite(Date.parse(stored.shownAt)) ? stored.shownAt : evening;
  return { due: true, since, record: { day, since, shownAt: now.toISOString() } };
}

/**
 * `triage` or `events` of null means that read did not answer: the section is
 * unknown (null), which is not the same as nothing to report ([]).
 * @returns {null|{name:string, greeting:string, first:Object|null, overnight:Object[]|null, today:Object[]|null, speech:string}}
 */
export function composeMorningBrief({ board, triage, events, since, now = new Date() }) {
  const mine = scopedDeals(board, 'mine');
  if (!mine || !identity(board.actor)) return null;
  const actor = board.actor, name = ACTOR_LABEL[actor] || actor;
  const today = localToday(now);
  const visible = new Map(board.deals.map(deal => [deal.id, deal]));
  const owned = new Set(mine.map(deal => deal.id));

  let needs = null;
  const todayState = !validTriage(triage?.items) ? 'unavailable' : triage.items.length >= TRIAGE_CAP ? 'incomplete' : 'ready';
  if (todayState === 'ready') {
    const seen = new Set();
    const dated = triage.items
      .filter(item => item.subject_type === 'deal' && visible.has(item.subject_id) && (item.owner === actor || (item.owner == null && owned.has(item.subject_id))) && toDay(item.due_on) && toDay(item.due_on) <= today)
      .sort((a, b) => a.due_on.localeCompare(b.due_on))
      .map(item => ({ id: item.subject_id, name: visible.get(item.subject_id).name, text: item.what || 'Due', day: toDay(item.due_on) }));
    const flagged = mine.filter(deal => deal.attention).map(deal => ({ id: deal.id, name: deal.name, text: deal.next_step || 'Flagged', day: null }));
    needs = [...dated, ...flagged].filter(item => !seen.has(item.id) && seen.add(item.id)).map(item => ({
      key: `deal:${item.id}`, href: dealHref(item.id), name: item.name, text: item.text,
      when: !item.day ? 'Flagged' : item.day < today ? `Overdue · ${dayLabel(item.day)}` : 'Today',
      tone: !item.day ? 'flagged' : item.day < today ? 'overdue' : 'today',
    }));
  }

  let overnight = null;
  if (validBriefEvents(events)) {
    const boundary = Date.parse(since);
    const receipts = events
      .filter(event => event?.actor !== actor && Date.parse(event?.recorded_at) > boundary)
      .map(event => normalizeChangeEvent(event, { dealName: id => visible.get(id)?.name, actorLabel: slug => ACTOR_LABEL[slug] }))
      .filter(Boolean).sort(compareReceipts);
    const byDeal = new Map();
    for (const receipt of receipts) (byDeal.get(receipt.deal_id) || byDeal.set(receipt.deal_id, []).get(receipt.deal_id)).push(receipt);
    overnight = [...byDeal.values()].slice(0, BRIEF_LIMIT).map(([latest, ...older]) => ({
      key: `deal:${latest.deal_id}`, href: dealHref(latest.deal_id), name: latest.deal_name,
      text: latest.after ? `${latest.action} → ${latest.after}` : latest.action,
      when: [latest.actor_label, clock(latest.recorded_at), older.length ? `+${older.length}` : ''].filter(Boolean).join(' · '),
    }));
  }

  const first = needs?.[0] || null;
  const rest = needs ? needs.slice(1, BRIEF_LIMIT + 1) : null;
  const hour = now.getHours();
  const greeting = `Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${name}`;
  return { name, greeting, first, overnight, today: rest, todayState, speech: speak(greeting, first, overnight, rest, todayState) };
}

// Bound each clause first so the priority and read failures always fit.
// Optional trailing details use only the remaining spoken budget.
function speak(greeting, first, overnight, today, todayState) {
  const concise = (text, limit) => {
    const words = String(text ?? '').trim().split(/\s+/);
    return words.length <= limit ? words.join(' ') : `${words.slice(0, limit).join(' ')}…`;
  };
  const kept = [`${concise(greeting, 8)}.`];
  if (first) kept.push(`First, ${concise(first.text, 18)}, for ${concise(first.name, 8)}.`);
  if (today === null) kept.push(`Today is ${todayState}.`);
  if (overnight === null) kept.push('Overnight changes are unavailable.');
  const clauses = [];
  for (const item of overnight || []) clauses.push(`Overnight, ${concise(item.name, 8)}: ${concise(item.text.replace('→', 'to'), 14)}.`);
  for (const item of today || []) clauses.push(`Also today, ${concise(item.text, 14)}, for ${concise(item.name, 8)}.`);
  for (const clause of clauses) {
    if ([...kept, clause].join(' ').split(/\s+/).length <= SPOKEN_WORDS) kept.push(clause);
  }
  return kept.join(' ');
}
