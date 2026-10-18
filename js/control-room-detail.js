// The Control Room detail pane (V2 step 3, slice C2). Display only: it reads one
// record by kind and never writes. Header, then the next human action, then the
// properties, then the activity timeline.
//
// What each read carries as history (checked against the live verbs, gap G4):
//  - work-request-card: `acting_identity` (each recorded act with `acted_at`)
//    and `outcome_feedback_history`. There is no other event list.
//  - get-incident: `trace` (correlated deploy/run/check rows with
//    `occurred_at`), `facts` and `hypotheses`.
//  - read-loop: `amendments` only. A loop with none has no history to show.
// Every other kind has no detail read here, and the pane says so instead of
// making one up.
import { escapeText as escapeHtml } from './change-receipts.mjs';

export const TIMELINE_LIMIT = 30;
const text = (value) => typeof value === 'string' && value.trim() !== '';
const humanize = (value) => { const words = String(value || '').replace(/[_-]+/g, ' ').trim(); return words ? words[0].toUpperCase() + words.slice(1) : ''; };
const time = (value) => { const at = Date.parse(value); return Number.isFinite(at) ? at : null; };

/** Which read opens a queue item, or null when no detail read exists for its kind. */
export function detailRequest(item) {
  if (!item) return null;
  const raw = String(item.id).slice(String(item.kind).length + 1);
  switch (item.kind) {
    case 'work_request': return { method: 'workRequestCard', args: { work_request: item.ref }, verb: 'work-request-card' };
    case 'incident': return { method: 'getIncident', args: { ref: item.ref, fact_limit: 50 }, verb: 'get-incident' };
    case 'loop': return { method: 'readLoop', args: { loop_id: raw, ...(item.loopKind ? { kind: item.loopKind } : {}) }, verb: 'read-loop' };
    default: return null;
  }
}

/** `read-loop` answers a miss inside the payload, so a read can succeed and still refuse. */
export function payloadRefusal(kind, payload) {
  if (!payload || typeof payload !== 'object') return 'The read returned nothing';
  if (kind === 'loop' && text(payload.error)) return humanize(payload.error);
  if (kind === 'loop' && !payload.loop) return 'The loop was not found';
  if (kind === 'incident' && !payload.incident) return 'The incident was not found';
  if (kind === 'work_request' && payload.ok === false) return humanize(payload.error || 'refused');
  return null;
}

/** History events from a detail payload, oldest first. `null` means the kind keeps no history list. */
export function timelineEvents(kind, payload) {
  if (!payload) return null;
  const events = [];
  const push = (at, type, label, detail = '') => events.push({ at: time(at), atText: text(at) ? at : null, type, label, detail: text(detail) ? detail : '' });
  if (kind === 'work_request') {
    if (!Array.isArray(payload.acting_identity) && !Array.isArray(payload.outcome_feedback_history)) return null;
    for (const act of payload.acting_identity || []) {
      if (!act) continue;
      const who = text(act.recorded_as) ? act.recorded_as : null;
      const agent = act.hand === 'agent' && text(act.performed_by) && act.performed_by !== who ? `, performed by ${act.performed_by}` : '';
      push(act.acted_at, `act:${act.act}`, humanize(act.act) || 'Recorded act', who ? `Recorded as ${who}${agent}` : agent.slice(2));
    }
    for (const feedback of payload.outcome_feedback_history || []) {
      if (!feedback) continue;
      push(feedback.recorded_at ?? feedback.accepted_at ?? feedback.proposed_at, 'feedback',
        `Outcome feedback${text(feedback.status) ? `: ${humanize(feedback.status).toLowerCase()}` : ''}`, feedback.summary ?? feedback.text ?? '');
    }
  } else if (kind === 'incident') {
    if (!Array.isArray(payload.trace) && !Array.isArray(payload.facts)) return null;
    for (const step of payload.trace || []) {
      if (!step) continue;
      push(step.occurred_at, `trace:${step.kind}:${step.state}`, `${humanize(step.kind) || 'Event'} ${humanize(step.state).toLowerCase()}`.trim(), step.detail ?? step.ref ?? '');
    }
    for (const fact of payload.facts || []) {
      if (!fact) continue;
      push(fact.recorded_at ?? fact.observed_at, 'fact', 'Fact recorded', fact.text ?? fact.statement ?? '');
    }
    for (const hypothesis of payload.hypotheses || []) {
      if (!hypothesis) continue;
      push(hypothesis.recorded_at, 'hypothesis', `Hypothesis${text(hypothesis.status) ? `, ${hypothesis.status}` : ''}`, hypothesis.statement ?? hypothesis.text ?? '');
    }
  } else if (kind === 'loop') {
    if (!Array.isArray(payload.amendments)) return null;
    for (const amendment of payload.amendments) {
      if (!amendment) continue;
      push(amendment.amended_at ?? amendment.recorded_at ?? amendment.created_at, 'amendment', 'Amended', amendment.reason ?? amendment.note ?? amendment.summary ?? '');
    }
  } else return null;
  // Stable: rows without a time keep their read order after the dated ones.
  return events.map((event, index) => ({ event, index }))
    .sort((a, b) => (a.event.at ?? Infinity) - (b.event.at ?? Infinity) || a.index - b.index)
    .map(({ event }) => event);
}

/** Consecutive events of the same type collapse into one group line. */
export function groupEvents(events) {
  const groups = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && last.type === event.type) last.events.push(event);
    else groups.push({ type: event.type, label: event.label, events: [event] });
  }
  return groups;
}

/** The last `limit` events, grouped, plus how many older events are hidden. */
export function visibleTimeline(events, { limit = TIMELINE_LIMIT, showAll = false } = {}) {
  const hidden = showAll ? 0 : Math.max(0, events.length - limit);
  return { hidden, groups: groupEvents(events.slice(hidden)) };
}

/** The one thing a human does next, as the read states it. */
export function nextHumanAction(kind, payload) {
  if (!payload) return null;
  if (kind === 'work_request') {
    const next = payload.next_human_action;
    const label = typeof next === 'string' ? next : next?.label;
    return text(label) ? { label, note: null } : null;
  }
  if (kind === 'incident') {
    const incident = payload.incident || {};
    return text(incident.next_action) ? { label: incident.next_action, note: text(incident.blocked_by) ? `Blocked by ${incident.blocked_by}` : null } : null;
  }
  if (kind === 'loop') {
    const loop = payload.loop || {};
    return text(loop.blocker_detail) ? { label: loop.blocker_detail, note: text(loop.unblocks) ? `Unblocks: ${loop.unblocks}` : null } : null;
  }
  return null;
}

const day = (value) => { const at = time(value); return at === null ? null : new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
const days = (n) => `${n.toLocaleString('en-US')} ${n === 1 ? 'day' : 'days'}`;

/** Property rows: what the queue row and the read both know, labelled in words. */
export function properties(item, payload) {
  const rows = [];
  const owner = item.holder || item.owner;
  rows.push(['Owner', owner || 'Unassigned']);
  if (Number.isFinite(item.age)) rows.push(['Open for', days(item.age)]);
  if (item.lastActivityAt && day(item.lastActivityAt)) rows.push(['Last activity', day(item.lastActivityAt)]);
  if (item.kind === 'work_request' && payload) {
    if (text(payload.triage?.classification)) rows.push(['Triage', humanize(payload.triage.classification)]);
    if (text(payload.source?.label)) rows.push(['Source', payload.source.label]);
    if (Array.isArray(payload.acceptance_criteria)) rows.push(['Acceptance', payload.acceptance_criteria.length ? `${payload.acceptance_criteria.length} criteria` : 'None recorded']);
  }
  if (item.kind === 'incident' && payload?.incident) {
    const incident = payload.incident;
    if (text(incident.severity)) rows.push(['Severity', incident.severity]);
    if (text(incident.environment)) rows.push(['Environment', humanize(incident.environment)]);
    if (Number.isFinite(incident.occurrences)) rows.push(['Occurrences', incident.occurrences.toLocaleString('en-US')]);
    if (text(incident.business_impact)) rows.push(['Impact', incident.business_impact]);
  } else if (item.kind === 'incident' && item.severity) rows.push(['Severity', item.severity]);
  if (item.kind === 'loop' && payload?.loop) {
    const loop = payload.loop;
    if (text(loop.number)) rows.push(['Loop', `#${loop.number}`]);
    if (text(loop.domain)) rows.push(['Domain', humanize(loop.domain)]);
    if (text(loop.blocker_class)) rows.push(['Waiting on', humanize(loop.blocker_class)]);
  }
  if (item.version != null && item.version !== '') rows.push(['Version', String(item.version)]);
  return rows;
}

const NO_HISTORY = {
  work_request: 'This Work Request has no recorded acts or outcome feedback yet.',
  incident: 'This incident has no trace or facts recorded yet.',
  loop: 'This loop has never been amended. read-loop returns amendments only, so there is no other history to show.',
};
const NO_READ = 'The Control Room has no detail read for this kind yet, so there is no timeline. The properties come from the queue row.';

const clock = (event) => event.at === null ? 'No time recorded'
  : new Date(event.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

function eventLine(event) {
  return `<li class="cr-event"><span class="cr-event-label">${escapeHtml(event.label)}</span>${event.detail ? `<span class="cr-event-detail">${escapeHtml(event.detail)}</span>` : ''}<time class="cr-event-time"${event.atText ? ` datetime="${escapeHtml(event.atText)}"` : ''}>${escapeHtml(clock(event))}</time></li>`;
}
function groupLine(group) {
  if (group.events.length === 1) return eventLine(group.events[0]);
  const first = group.events[0], last = group.events.at(-1);
  return `<li class="cr-event cr-event-group"><details><summary><span class="cr-event-label">${escapeHtml(group.label)}</span><span class="cr-event-count">${group.events.length.toLocaleString('en-US')} times</span><time class="cr-event-time">${escapeHtml(clock(first))} to ${escapeHtml(clock(last))}</time></summary><ol class="cr-timeline cr-timeline-nested">${group.events.map(eventLine).join('')}</ol></details></li>`;
}

export function timelineHtml(item, events, { showAll = false } = {}) {
  if (events === null) return `<p class="cr-timeline-empty">${escapeHtml(detailRequest(item) ? NO_HISTORY[item.kind] : NO_READ)}</p>`;
  if (!events.length) return `<p class="cr-timeline-empty">${escapeHtml(NO_HISTORY[item.kind] || NO_READ)}</p>`;
  const { hidden, groups } = visibleTimeline(events, { showAll });
  return `${hidden ? `<button class="cr-older" type="button" data-show-older>Show ${hidden.toLocaleString('en-US')} older ${hidden === 1 ? 'event' : 'events'}</button>` : ''}<ol class="cr-timeline">${groups.map(groupLine).join('')}</ol>`;
}

export const SKELETON_HTML = `<div class="cr-timeline-skeleton" aria-hidden="true">${'<span class="skeleton-line"></span><span class="skeleton-line short"></span>'.repeat(4)}</div>`;

function header(item) {
  return `<header class="cr-detail-head"><button class="cr-detail-back" type="button" data-detail-close aria-label="Back to the list"><span aria-hidden="true">←</span> Back</button><p class="cr-detail-ref" data-detail-ref>${escapeHtml(item.ref)}</p><details class="cr-detail-heading"><summary><h2 class="cr-detail-title" id="crDetailTitle" tabindex="-1">${escapeHtml(item.title)}</h2><span class="cr-title-expand">Show full title</span><span class="cr-title-collapse">Show less</span></summary></details><p class="cr-detail-kind"><span>${escapeHtml(item.kindLabel)}</span><span aria-hidden="true">·</span><span>${escapeHtml(humanize(item.state) || 'State not recorded')}</span></p><button class="cr-detail-close" type="button" data-detail-close aria-label="Close detail" title="Close (Esc)"><span aria-hidden="true">×</span></button></header>`;
}
function nextBlock(next, state) {
  if (state === 'loading') return '<section class="cr-next" aria-label="Next human action"><h3>Next human action</h3><span class="skeleton-line"></span></section>';
  if (state !== 'read') return '<section class="cr-next" aria-label="Next human action"><h3>Next human action</h3><p class="cr-next-none">Unavailable</p></section>';
  return `<section class="cr-next" aria-label="Next human action"><h3>Next human action</h3>${next ? `<p class="cr-next-label">${escapeHtml(next.label)}</p>${next.note ? `<p class="cr-next-note">${escapeHtml(next.note)}</p>` : ''}` : '<p class="cr-next-none">None recorded in this read.</p>'}</section>`;
}
function propertyBlock(rows) {
  return `<dl class="cr-props">${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
}

/** The pane's whole body for one item in one read state. */
export function detailHtml(item, read = { state: 'loading' }, { showAll = false } = {}) {
  const loading = read.state === 'loading';
  const payload = read.state === 'read' ? read.payload : null;
  const events = read.state === 'read' ? timelineEvents(item.kind, payload) : null;
  const unavailable = read.state === 'error' || read.state === 'none';
  const availability = read.state === 'error'
    ? `<div class="state-block cr-detail-availability" data-detail-unavailable role="status"><h3>The record could not be read</h3><p>${escapeHtml(read.reason)}. Only queue properties are available.</p><button class="btn" type="button" data-detail-retry>Try again</button></div>`
    : read.state === 'none' ? `<div class="state-block cr-detail-availability" data-detail-unavailable role="status"><h3>Detail read unavailable</h3><p>${escapeHtml(NO_READ)}</p></div>` : '';
  let activity;
  if (loading) activity = SKELETON_HTML;
  else activity = timelineHtml(item, events, { showAll });
  return `${header(item)}${availability}${nextBlock(payload ? nextHumanAction(item.kind, payload) : null, read.state)}${propertyBlock(properties(item, payload))}${unavailable ? '' : `<section class="cr-activity" aria-labelledby="crActivityTitle"><h3 id="crActivityTitle">Activity</h3>${activity}</section>`}`;
}

const reasonOf = (error) => [401, 403].includes(error?.status) ? 'Sign in required'
  : text(error?.payload?.error) ? humanize(error.payload.error) : 'Updates unavailable';

/**
 * Mount the pane on its aside. `open(item)` reads the record for that item;
 * a later `open` wins over an earlier read still in flight.
 */
export function mountDetail({ node, client, onClose = () => {}, readDeadline = (run) => run() }) {
  let current = null, read = { state: 'loading' }, showAll = false, sequence = 0;
  const render = () => { if (current) node.innerHTML = detailHtml(current, read, { showAll }); };
  async function load() {
    const ticket = ++sequence, request = detailRequest(current);
    if (!request || typeof client?.[request.method] !== 'function') { read = { state: 'none' }; render(); return; }
    read = { state: 'loading' }; render();
    try {
      const payload = await readDeadline(() => client[request.method](request.args));
      if (ticket !== sequence) return;
      const refusal = payloadRefusal(current.kind, payload);
      read = refusal ? { state: 'error', reason: refusal } : { state: 'read', payload };
    } catch (error) { if (ticket !== sequence) return; read = { state: 'error', reason: reasonOf(error) }; }
    render();
  }
  node.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-detail-close]')) { onClose(); return; }
    if (target?.closest('[data-show-older]')) { showAll = true; render(); return; }
    if (target?.closest('[data-detail-retry]')) load();
  });
  return {
    open(item) { if (current?.id === item.id && read.state !== 'error') return; current = item; showAll = false; load(); },
    clear() { sequence++; current = null; },
    get item() { return current; },
  };
}
