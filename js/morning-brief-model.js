// Doc's morning brief. Pure: the view hands in live reads and app-only memory
// of when the brief was last shown; this returns what to show and say.
import { scopedDeals } from './home-dashboard-model.js';
import { localToday, toDay } from './calendar-model.js';
import { normalizeChangeEvent, compareReceipts } from './change-receipts.mjs';
import { ACTOR_LABEL } from './client.js';

export const BRIEF_LIMIT = 3;
const SPOKEN_WORDS = 75;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dayLabel = day => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const clock = at => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
const link = id => `/deals?deal=${encodeURIComponent(id)}`;

/**
 * Once per local day. A new day's overnight window starts where the last
 * brief was shown; the first ever brief starts at 6 PM the previous evening.
 * Reopening the same day keeps the same window.
 */
export function briefWindow(stored, now = new Date()) {
  const day = localToday(now);
  if (stored?.day === day && typeof stored.since === 'string') return { due: false, since: stored.since, record: stored };
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
  if (!mine) return null;
  const actor = board.actor, name = ACTOR_LABEL[actor] || actor;
  const today = localToday(now);
  const visible = new Map(board.deals.map(deal => [deal.id, deal]));
  const owned = new Set(mine.map(deal => deal.id));

  let needs = null;
  if (Array.isArray(triage?.items)) {
    const seen = new Set();
    const dated = triage.items
      .filter(item => item?.subject_type === 'deal' && owned.has(item.subject_id) && (item.owner == null || item.owner === actor) && toDay(item.due_on) && toDay(item.due_on) <= today)
      .sort((a, b) => a.due_on.localeCompare(b.due_on))
      .map(item => ({ id: item.subject_id, name: visible.get(item.subject_id).name, text: item.what || 'Due', day: toDay(item.due_on) }));
    const flagged = mine.filter(deal => deal.attention).map(deal => ({ id: deal.id, name: deal.name, text: deal.next_step || 'Flagged', day: null }));
    needs = [...dated, ...flagged].filter(item => !seen.has(item.id) && seen.add(item.id)).map(item => ({
      key: `deal:${item.id}`, href: link(item.id), name: item.name, text: item.text,
      when: !item.day ? 'Flagged' : item.day < today ? `Overdue · ${dayLabel(item.day)}` : 'Today',
      tone: !item.day ? 'flagged' : item.day < today ? 'overdue' : 'today',
    }));
  }

  let overnight = null;
  if (Array.isArray(events)) {
    const boundary = Date.parse(since);
    const receipts = events
      .filter(event => event?.actor !== actor && Date.parse(event?.recorded_at) > boundary)
      .map(event => normalizeChangeEvent(event, { dealName: id => visible.get(id)?.name, actorLabel: slug => ACTOR_LABEL[slug] }))
      .filter(Boolean).sort(compareReceipts);
    const byDeal = new Map();
    for (const receipt of receipts) (byDeal.get(receipt.deal_id) || byDeal.set(receipt.deal_id, []).get(receipt.deal_id)).push(receipt);
    overnight = [...byDeal.values()].slice(0, BRIEF_LIMIT).map(([latest, ...older]) => ({
      key: `deal:${latest.deal_id}`, href: link(latest.deal_id), name: latest.deal_name,
      text: latest.after ? `${latest.action} → ${latest.after}` : latest.action,
      when: [latest.actor_label, clock(latest.recorded_at), older.length ? `+${older.length}` : ''].filter(Boolean).join(' · '),
    }));
  }

  const first = needs?.[0] || null;
  const rest = needs ? needs.slice(1, BRIEF_LIMIT + 1) : null;
  const hour = now.getHours();
  const greeting = `Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${name}`;
  return { name, greeting, first, overnight, today: rest, speech: speak(greeting, first, overnight, rest) };
}

// About thirty seconds: the first action, then what changed, then what else is
// due, dropping trailing clauses rather than speeding anything up.
function speak(greeting, first, overnight, today) {
  const clauses = [`${greeting}.`];
  if (first) clauses.push(`First, ${first.text}, for ${first.name}.`);
  for (const item of overnight || []) clauses.push(`Overnight, ${item.name}: ${item.text.replace('→', 'to')}.`);
  for (const item of today || []) clauses.push(`Also today, ${item.text}, for ${item.name}.`);
  const kept = [];
  for (const clause of clauses) {
    if ([...kept, clause].join(' ').split(/\s+/).length > SPOKEN_WORDS) break;
    kept.push(clause);
  }
  return kept.join(' ');
}
