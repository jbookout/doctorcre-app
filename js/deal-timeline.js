import { createMcpRequests } from './mcp-requests.mjs';
import { createCurrentRead } from './current-read.mjs';

import { businessDay } from './business-date.js';
import { COLUMNS, columnBySlug, columnByValue, noteText, PHASE_DATE_KIND } from './pipeline-model.js';
import { compareInstants, escapeText, fieldLabel, readableValue } from './change-receipts.mjs';
import { sourceTime } from './email-source-line.js';
import { concise, isEngineDealDetail, PARKING_REASONS } from './local-deals-model.js';
import { ACTOR_LABEL, authorLabel, dealTypeLabel } from './client.js';

const DAY = 86400000;
const esc = escapeText;
// Wire kinds, never prose matching or dates inferred from lease duration.
const DATE_KINDS = [
  { kind: 'loi_expiry', label: 'LOI expiry', aliases: ['loi', 'loi_due'], saveKind: 'loi_expiry', deadline: true },
  { kind: 'due_diligence', label: 'Due diligence', aliases: ['due_diligence_deadline', 'dd_deadline'], saveKind: 'due_diligence', deadline: true },
  { kind: 'lease_commencement', label: 'Lease commencement', aliases: ['commencement'] },
  { kind: 'lease_expiration', label: 'Lease expiration', saveKind: 'lease_end', deadline: true },
  { kind: 'rent_start', label: 'Rent start', aliases: ['rent_commencement'], saveKind: 'rent_start' },
  { kind: 'option_window', label: 'Option notice', aliases: ['option_exercise'], saveKind: 'option_notice', deadline: true },
  { kind: PHASE_DATE_KIND, label: 'Phase effective date', saveKind: PHASE_DATE_KIND, optional: true },
  { kind: 'other', label: 'Other', saveKind: 'other', optional: true },
];

export const CRITICAL_DATE_OPTIONS = DATE_KINDS.flatMap(({ saveKind, label }) => saveKind ? [[saveKind, label]] : []);
const dateKind = kind => kind && DATE_KINDS.find(d => d.kind === kind || d.saveKind === kind || d.aliases?.includes(kind));

export function criticalDateLabel(kind, definition = dateKind(kind)) {
  const words = kind?.replace(/[_-]+/g, ' ') || '';
  return definition?.label || words.charAt(0).toUpperCase() + words.slice(1);
}

export function calendarDay(value) {
  if (typeof value !== 'string') return null;
  const day = value.slice(0,10);
  if (!/^\d{4}-\d\d-\d\d$/.test(day)) return null;
  const stamp = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === day ? day : null;
}
const today = now => businessDay(new Date(now));
export function dateCaption(day) {
  return day ? new Date(day+'T12:00:00Z').toLocaleDateString([], {month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}) : '—';
}
export function countdown(date, now = Date.now()) {
  if (!calendarDay(date.day)) return { state:'unknown', text:'—' };
  if (date.status === 'cleared') return {state:'complete',text:'Cleared'};
  if (date.status === 'passed') return {state:'past',text:'Passed'};
  const days = Math.round((Date.parse(date.day)-Date.parse(today(now)))/DAY);
  if (!days) return {state:'today',text:date.deadline ? 'Due today' : 'Today'};
  if (days > 0) return {state:days <= 7 && date.deadline ? 'soon':'upcoming',text:`${days} day${days === 1 ? '' : 's'}`};
  return {state:date.deadline ? 'overdue':'past',text:date.deadline ? `${-days} day${days === -1 ? '' : 's'} overdue` : `${-days} day${days === -1 ? '' : 's'} ago`};
}
export function dealTimeline(detail, now = Date.now(), dateDecisions = false) {
  const entryByPhase = new Map();
  for (const [phase, value] of Object.entries(detail.deal.phase_started_on || {})) {
    const column = columnBySlug(phase) || columnByValue(phase);
    const day = calendarDay(value);
    if (column && day) entryByPhase.set(column.slug, day);
  }
  const phases = COLUMNS.map(c => ({...c,day:entryByPhase.get(c.slug) || null,current:detail.deal.phase === c.value}));
  const lease = detail.lease?.status === 'current' ? detail.lease : null;
  const recordedDates = [...(detail.critical_dates || [])];
  if (lease) {
    if (calendarDay(lease.commencement_on)) recordedDates.unshift({id:`lease-${lease.id}-commencement`,kind:'lease_commencement',due_on:lease.commencement_on,note:lease.evidence_ref,source:lease.source});
    if (calendarDay(lease.expiration_on)) recordedDates.push({id:`lease-${lease.id}-expiration`,kind:'lease_expiration',due_on:lease.expiration_on,note:lease.evidence_ref,source:lease.source});
  }
  const rows = recordedDates.map((row,i) => {
    const definition = dateKind(row.kind);
    const value = row.due_on ?? row.date;
    const original = noteText(row.note);
    const namedOther = row.kind === 'other' && !isEngineDealDetail(detail) && original;
    const kindLabel = criticalDateLabel(row.kind, definition);
    return {dateState:calendarDay(value) ? 'dated' : value == null || value === '' ? 'missing' : 'invalid',id:row.id || `date-${i}`,kind:definition?.kind || row.kind,label:namedOther || kindLabel || row.label || 'Date',
      day:calendarDay(value),original:namedOther ? '' : original,
      evidence:row.source || '',status:row.status,deadline:Boolean(definition?.deadline)};
  });
  // Co-located dates share a card, preserving every original and status.
  const grouped = new Map();
  const undated = rows.filter(row => !row.day);
  for (const row of rows.filter(row => row.day)) {
    const key = dateDecisions && isSavedDate(row) ? row.id
      : JSON.stringify([row.kind, row.day, row.status || '', row.kind === 'other' ? row.original || row.label : null]);
    const existing = grouped.get(key);
    const references = [row.original,row.evidence].filter(Boolean);
    if (existing) existing.references.push(...references);
    else grouped.set(key,{...row,references});
  }
  const dates = [...grouped.values()].map(({references,...row}) => ({...row,
    original:[...new Set(references)].join('\n\n')})).sort((a,b) => a.day.localeCompare(b.day));
  const missing = DATE_KINDS.filter(d => !d.optional && !rows.some(row => row.kind === d.kind));
  const entries = (detail.entries || []).filter(e => e.source !== 'hold').map(e => ({...e, day:calendarDay(e.when), type:e.kind}));
  return {phases,dates,undated,missing,entries,today:today(now)};
}

const isSavedDate = row => /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(row.id);
const DATE_STATES = new Map([['proposed','Proposed'], ['open','Confirmed'], ['cleared','Done'], ['done','Done'], ['dropped','Dropped'], ['passed','Passed']]);
function dateDecisionsHtml(date) {
  if (!isSavedDate(date)) return '';
  const state = DATE_STATES.get(date.status);
  const open = date.status === 'open';
  const proposed = date.status === 'proposed';
  return `${state ? `<small>${state}</small>` : ''}${open || proposed ? `
    <form data-date-decision="${esc(date.id)}">
      ${proposed ? '<button type="submit" class="btn" value="confirm" formnovalidate>Confirm</button>' : ''}
      <label>Reason <input name="reason" required maxlength="1000"></label>
      ${open ? '<button type="submit" class="btn" value="done">Mark done</button>' : ''}
      <button type="submit" class="btn" value="dropped">Drop</button>
      ${open ? '<button type="submit" class="btn" value="passed">Mark passed</button>' : ''}
    </form>` : ''}`;
}

export function renderCriticalDates(detail, now = Date.now(), dateDecisions = false) {
  const view = dealTimeline(detail,now,dateDecisions);
  return `<section class="critical-dates" data-detail-read="dates" aria-label="Critical dates">${view.dates.map(d => {
    const count = countdown(d,now);
    const settled = dateDecisions && DATE_STATES.has(d.status) && d.status !== 'open';
    return `<article class="critical-date" data-date-id="${esc(d.id)}" data-state="${settled ? esc(d.status) : count.state}"><span>${esc(d.label)}</span>${settled ? '' : `<strong data-countdown="${esc(d.day)}" data-deadline="${Boolean(d.deadline)}" data-date-status="${esc(d.status || '')}">${esc(count.text)}</strong>`}<time datetime="${esc(d.day)}">${esc(dateCaption(d.day))}</time>${d.original || d.evidence ? `<details><summary data-detail-focus="date-original:${esc(d.id)}">Details</summary><p class="note-original">${esc(d.original || d.evidence)}</p></details>` : ''}${dateDecisions ? dateDecisionsHtml(d) : ''}</article>`;
  }).join('')}${view.undated.map(d => `<article class="critical-date" data-date-id="${esc(d.id)}" data-state="unknown" data-date-status="${esc(d.status || '')}"><span>${esc(d.label)}</span><strong>${d.dateState === 'missing' ? 'Date not recorded' : 'Date unavailable'}</strong>${d.status ? `<small>Status: ${esc(d.status)}</small>` : ''}${d.original || d.evidence ? `<details><summary data-detail-focus="date-original:${esc(d.id)}">Details</summary>${d.original ? `<p class="note-original">${esc(d.original)}</p>` : ''}${d.evidence ? `<p class="date-source">Source: ${esc(d.evidence)}</p>` : ''}</details>` : ''}</article>`).join('')}${view.missing.map(d => `<article class="critical-date"><span>${esc(d.label)}</span><strong>Not recorded</strong></article>`).join('')}</section>`;
}

const timelineActor = actor => Object.hasOwn(ACTOR_LABEL, actor) ? ACTOR_LABEL[actor] : actor ? 'Automatically' : '';
const activityLabels = { call: 'Call', email: 'Email', meeting: 'Meeting' };
const STEP_STATES = new Map([['done', 'Done'], ['cancelled', 'Cancelled'], ['expired', 'Expired']]);
const closedMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', trailingZeroDisplay: 'stripIfInteger' });

function changeText({ field, new_value }) {
  if (field === 'phase') {
    const phase = new_value === 'dead' ? 'Lost' : columnBySlug(new_value)?.label || readableValue(field, new_value);
    return `Moved to ${phase}`;
  }
  if (field === 'operating_state') {
    if (new_value?.state === 'parked') {
      const reason = PARKING_REASONS.get(new_value.reason);
      const note = typeof new_value.note === 'string' ? new_value.note : '';
      return ['Parked', reason, note].filter(Boolean).join(' · ');
    }
    const state = typeof new_value === 'string' ? new_value : readableValue(field, new_value);
    return /^(active|active work)$/i.test(state) ? 'Active again' : state;
  }
  if (field === 'attention' && typeof new_value === 'boolean') {
    return new_value ? 'Needs attention' : 'Needs attention cleared';
  }
  const label = field === 'won_value' ? 'Closed value' : fieldLabel(field);
  let value = readableValue(field, new_value, { actorLabel: timelineActor });
  if (field === 'won_value' && Number.isFinite(new_value)) value = closedMoney.format(new_value);
  if (typeof new_value === 'string' && new_value.length === 10 && calendarDay(new_value)) value = dateCaption(new_value);
  return label ? `${label} · ${value}` : 'Deal changed';
}

export function engineTimelineEntries(detail) {
  const notes = detail.thread || [];
  const noteIds = new Set(notes.map(note => note.id));
  /** @type {{ type: string, when: string, actor: string, text: string }[]} */
  const entries = [
    ...notes.map(note => ({ type: 'Note', when: note.created_at, actor: note.actor, text: noteText(note.text) })),
    ...(detail.activities || []).map(activity => ({
      type: activityLabels[activity.kind] || 'Activity', when: activity.occurred_at,
      actor: activity.actor, text: noteText(activity.summary).trim() || noteText(activity.detail),
    })),
    ...(detail.documents || []).map(file => ({
      type: 'Document', when: file.prepared_at, actor: file.actor, text: file.name,
    })),
    ...(detail.next_actions || []).map(step => ({
      type: step.title ? 'Checklist item' : 'Next step', when: step.updated_at || step.due_on, actor: step.actor,
      text: [
        step.title || step.description,
        STEP_STATES.get(step.status),
        step.updated_at && calendarDay(step.due_on) && `Due ${dateCaption(step.due_on)}`,
      ].filter(Boolean).join(' · '),
    })),
    ...(detail.critical_dates || []).map(date => {
      const label = criticalDateLabel(date.kind) || 'Date';
      const due = calendarDay(date.due_on) && `Due ${dateCaption(date.due_on)}`;
      return {
        type: 'Critical date', when: date.updated_at, actor: date.actor,
        text: [...new Set([label, DATE_STATES.get(date.status), due, date.note].filter(Boolean))].join(' · '),
      };
    }),
    ...(detail.history || []).filter(event => !noteIds.has(event.activity_id)).map(event => ({
      type: event.field === 'note' ? 'Note' : event.field === 'phase' ? 'Phase move' : 'Change',
      when: event.recorded_at, actor: event.actor,
      text: event.field === 'note' ? noteText(event.new_value) : changeText(event),
    })),
  ];
  return entries.flatMap(({ type, when, actor, text }) => {
    if (!text?.trim() || !calendarDay(when)) return [];
    const dateOnly = when.length === 10;
    const instant = new Date(when);
    if (!Number.isFinite(instant.getTime())) return [];
    return [{
      type, when, actor: timelineActor(actor), text,
      day: dateOnly ? when : businessDay(instant),
      caption: dateOnly ? dateCaption(when) : sourceTime(when),
    }];
  }).sort((a, b) => b.day.localeCompare(a.day) || compareInstants(a.when, b.when));
}

const OLD_HISTORY_ACTION = new Map(Object.entries({
  'add-critical-date': 'Added a critical date',
  'add-premises': 'Added space to the deal',
  'backfill-document-attachments:document.attachments': 'Added document attachments',
  'complete-action:status': 'Finished a next step',
  'complete-one-action:status': 'Finished a next step',
  'create-national-market-deal': 'Opened a national account deal',
  'dismiss-email-proposal': 'Dismissed an email suggestion',
  import: 'Imported the deal',
  'log-activity': 'Logged an activity',
  'log-decision:decision': 'Added a decision',
  'new-deal': 'Opened the deal',
  'prepare-document:document': 'Prepared a document',
  'reattach-deal:client_id': 'Linked the deal to a client',
  'record-counter': 'Logged a counteroffer',
  'record-finding:address': 'Checked the address',
  'record-finding:code_requirement': 'Checked building code requirements',
  'record-finding:discrepancy': 'Checked for a discrepancy',
  'record-finding:market_study': 'Added market research',
  'record-finding:verified': 'Ran a verification check',
  'register-client-portal:client_portal': 'Set up the client website',
  'resolve-post-call-candidate:next_action': 'Confirmed a next step from a call',
  'set-lead': 'Changed the deal owner',
  'set-market-agent:market_agent': 'Changed the market agent',
  'set-next-action': 'Set a next step',
  'set-next-action:next_date': 'Changed the next step date',
  'set-next-step:next_step': 'Changed the next step',
  'update-deal:closed_on': 'Changed the closing date',
  'update-deal:invoiced_on': 'Changed the invoice date',
  'update-deal:lane': 'Changed the board lane',
  'update-deal:notes_path': 'Updated where the deal notes are kept',
  'update-deal:outcome': 'Changed the deal outcome',
  'update-deal:phase': 'Changed the phase',
  'update-deal:salesforce_id': 'Changed the Salesforce reference',
}));

const historicalActor = slug => timelineActor(slug) || 'Author unavailable';
const historicalPartner = slug => slug === 'joe-local' ? 'Joe'
  : Object.hasOwn(ACTOR_LABEL, slug) ? ACTOR_LABEL[slug] : 'Name unavailable';
const words = value => value.replace(/(^|[_-]+)([a-z])/g, (_, separator, letter) =>
  separator ? ' ' + letter : letter.toUpperCase());
function historicalDay(value) {
  const day = calendarDay(value);
  return day ? dateCaption(day) : 'Date unavailable';
}
const COUNTER_BASIS = new Map([
  ['usd_sf_yr', 'per square foot per year'], ['usd_sf_mo', 'per square foot per month'],
  ['usd_mo_gross', 'gross per month'], ['usd_yr_gross', 'gross per year'],
]);

const OLD_ACTIVITY_NAMES = new Map([
  ...Object.entries(activityLabels),
  ['email_in', 'Email received'], ['email_out', 'Email sent'], ['text', 'Text message'],
  ['counter_sent', 'Counteroffer sent'], ['counter_received', 'Counteroffer received'],
  ['loi', 'Letter of intent'], ['lease_signed', 'Lease signed'],
]);
const OLD_SUGGESTION_NAMES = new Map([
  ['file_to_deal', 'File email to this deal'], ['possible_new_deal', 'Possible new deal'],
  ['phase_move', 'Move to another phase'], ['next_step', 'Set a next step'], ['reply_draft', 'Draft a reply'],
]);
const OLD_HISTORY_KIND = new Map([
  ['add-critical-date', ['Date type', criticalDateLabel]],
  ['log-activity', ['Activity type', kind => OLD_ACTIVITY_NAMES.get(kind) || words(kind)]],
  ['dismiss-email-proposal', ['Suggestion type', kind => OLD_SUGGESTION_NAMES.get(kind) || words(kind)]],
]);

// References to old rows carry no display name. Only show facts the event actually held.
const OLD_HISTORY_FACTS = {
  name: ['Deal name'], client_name: ['Client'],
  phase: ['Phase', value => value === 'dead' ? 'Lost' : columnBySlug(value)?.label || words(value)],
  deal_type: [fieldLabel('kind'), words], market: ['Market'], agent_name: ['Market agent'],
  market_agent: ['Market agent'], lead: ['Deal owner', historicalPartner], owner: ['Assigned to', historicalPartner],
  assignee: ['Assigned to', historicalPartner], set_by: ['Set by', historicalActor],
  lane: ['Board lane', words], next_action: ['Next step'], next_step: ['Next step'],
  description: ['Next step'], summary: ['Summary'], reason: ['Reason'], outcome: ['Outcome', words],
  status: ['Status', words], closed_on: ['Closing date', historicalDay], invoiced_on: ['Invoice date', historicalDay],
  next_date: ['Next step date', historicalDay], due: ['Due date', historicalDay], due_on: ['Due date', historicalDay],
  found: ['Result', value => value ? 'Found' : 'Nothing found'], expires_on: ['Expires', historicalDay],
  proposes_correction: ['Suggested correction to', words], source: ['Where it came from'],
  building_created: ['New building added'], spaces: ['Spaces'], ownership: ['Owners listed'],
  client_portal_url: ['Client website'],
  salesforce_id: ['Salesforce reference'], round: ['Round'], side: ['From', words],
  rate: ['Rate', value => closedMoney.format(value)],
  basis: ['Rate basis', value => COUNTER_BASIS.get(value) || 'Details unavailable'],
  template: ['Template', words], filled: ['Fields filled'], owed: ['Fields still needed'],
  attachments: ['Attachments', value =>
    [value.pdf && 'PDF', value.working && 'Working copy'].filter(Boolean).join(', ') || 'None'],
  dropped_post_call_action_ids: ['Earlier call follow-ups cleared', value => String(value.length)],
};

function historicalValue(value, format) {
  if (value == null || value === '') return 'None';
  if (format) return format(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function importedFacts({ verb, old_value, new_value }) {
  const before = old_value ?? {};
  const after = new_value ?? {};
  const kind = OLD_HISTORY_KIND.get(verb);
  const facts = { ...OLD_HISTORY_FACTS, ...(kind ? { kind } : {}),
    ...(verb === 'new-deal' ? { reason: [fieldLabel('reason'), value => dealTypeLabel(value) || words(value)] } : {}) };
  return Object.entries(facts).flatMap(([key, [label, format]]) => {
    const had = Object.hasOwn(before, key);
    const has = Object.hasOwn(after, key);
    if (!had && !has) return [];
    const oldText = historicalValue(before[key], format);
    const newText = historicalValue(after[key], format);
    if (had && has && oldText !== newText) {
      return [after[key] === null ? `${label} cleared (was ${oldText})` : `${label}: ${oldText} to ${newText}`];
    }
    return [`${label}: ${has ? newText : oldText}`];
  }).join('\n');
}

export function renderImportedDealHistory(history) {
  if (!Array.isArray(history)) return '';
  const rows = history.filter(entry => entry?.imported === true).reverse().map(event => {
    const key = event.field == null ? event.verb : `${event.verb}:${event.field}`;
    const action = OLD_HISTORY_ACTION.get(key);
    const facts = action ? importedFacts(event) : '';
    return `<li><b>${esc(historicalActor(event.actor))}</b> <time datetime="${esc(event.recorded_at)}">${esc(sourceTime(event.recorded_at))}</time>
      <div>${action || 'Earlier deal activity'}</div>${facts ? `<p class="note-original">${esc(facts)}</p>` : ''}</li>`;
  });
  return rows.length ? `<section aria-labelledby="old-deal-history"><h2 id="old-deal-history">History from the old system</h2><ol class="workspace-events">${rows.join('')}</ol></section>` : '';
}

export function renderDealTimeline(detail, now = Date.now()) {
  const view = dealTimeline(detail,now);
  return `<section class="deal-timeline" data-detail-read="timeline" aria-label="Deal phases and timeline"><h3>Phase timeline</h3><ol class="phase-rail">${view.phases.map(p => `<li${p.current ? ' aria-current="step"' : ''}><span>${esc(p.label)}</span>${p.day ? `<time datetime="${esc(p.day)}">${esc(dateCaption(p.day))}</time>` : ''}</li>`).join('')}</ol></section>`;
}
export function renderDealUpdates(detail, now = Date.now()) {
  const entries = (detail.entries || []).filter(e => e.source !== 'document' && (e.source !== 'hold' || calendarDay(e.holdUntil) > today(now)))
    .map(e => e.source === 'hold' ? {...e, kind:`Held until ${dateCaption(calendarDay(e.holdUntil))}`} : e);
  if (!entries.length) return '';
  const activityIds = new Set((detail.activities || []).map(a => a.id).filter(id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)));
  const overview = concise(entries[0]?.summary, 72);
  const latestDate = new Date(entries[0].when || NaN);
  const latestDay = Number.isFinite(latestDate.getTime()) ? latestDate.toLocaleDateString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric'}) : 'Date not recorded';
  return `<section class="deal-updates" data-detail-read="updates" aria-label="Deal updates"><h3>Updates</h3>${entries.length ? `<details class="updates-history"><summary data-detail-focus="update-history"><span>${entries.length} update${entries.length === 1 ? '' : 's'} · ${esc(latestDay)} · ${esc(overview)}</span></summary>${(detail.activities || []).length >= 50 ? '<p class="updates-scope">Includes the latest 50 activities; older activities may be omitted.</p>' : ''}${entries.map(e => `<article class="deal-note" data-id="${esc(e.id)}" data-kind="${esc(e.kind)}"><div class="timeline-entry-top"><b>${esc(authorLabel(e.actor))}</b><time datetime="${esc(e.when || '')}">${esc(sourceTime(e.when, undefined, 'Date not recorded'))}</time></div><small>${esc(e.kind)}</small><p>${esc(e.summary)}</p>${activityIds.has(e.id) ? `<button type="button" class="btn" data-attribution-id="${esc(e.id)}" aria-expanded="false">Show deal attribution</button>` : ''}${e.original && e.original !== e.summary ? `<details><summary data-detail-focus="entry-original:${esc(e.id)}">Read full update</summary><p class="note-original">${esc(e.original)}</p></details>` : ''}</article>`).join('')}</details>` : '<p>No updates recorded.</p>'}</section>`;
}
export function updateCountdowns(root, now = Date.now()) {
  for (const node of root.querySelectorAll('[data-countdown]')) {
    const value = countdown({day:node.dataset.countdown,deadline:node.dataset.deadline === 'true',status:node.dataset.dateStatus},now);
    node.textContent = value.text; node.closest('.critical-date').dataset.state = value.state;
  }
}

export function createActivityAttributionRead(options = {}) {
  const request = createMcpRequests(options);
  return async (activityId, signal) => {
    const result = await request('read-activity-deal-attribution', { activity_id: activityId }, { signal });
    if (result.kind === 'authorization') throw Object.assign(new Error('Sign in to read attribution'), { status: result.status });
    if (result.kind !== 'payload' || result.isError) throw new Error('Activity attribution unavailable');
    return result.payload;
  };
}
export function mountActivityAttribution(root, { read = createActivityAttributionRead(), load = () => import('./ui-activity-attribution.generated.js'), onDenied = () => {} } = {}) {
  const current = createCurrentRead();
  let selected = null, view = null, host = null, busy = false, disposed = false;
  function clear(returnFocus = true) {
    current.invalidate(); busy = false;
    view?.dispose(); view = null; host?.remove(); host = null;
    const trigger = selected; selected = null;
    root.querySelectorAll('[data-attribution-id]').forEach(button => { button.disabled = false; button.setAttribute('aria-expanded','false'); });
    if (returnFocus && trigger?.isConnected) trigger.focus();
  }
  async function show(trigger) {
    if (busy || disposed || !root.isConnected) return;
    clear(false); selected = trigger; busy = true;
    trigger.setAttribute('aria-expanded','true');
    root.querySelectorAll('[data-attribution-id]').forEach(button => { button.disabled = button !== trigger; });
    host = document.createElement('div'); root.append(host);
    host.setAttribute('role','status'); host.textContent = 'Loading deal attribution…';
    const container = host;
    await current.run(async operation => {
      const module = await operation.read(load());
      view = module.mountActivityAttributionView(container, () => clear(), () => void show(trigger));
      view.update({kind:'loading'});
      const response = await operation.read(read(trigger.dataset.attributionId, operation.signal));
      return module.parseActivityDealAttribution(response, trigger.dataset.attributionId);
    }, {
      success(value) { view.update({kind:'result',value}); },
      failure(error) {
        if ([401,403].includes(error?.status)) { retire(); onDenied(error); return; }
        if (view) view.update({kind:'failure'});
        else {
          container.textContent = 'Deal attribution could not be loaded. ';
          const retry = document.createElement('button'); retry.type='button'; retry.className='btn'; retry.textContent='Retry attribution';
          retry.onclick=()=>void show(trigger); container.append(retry);
        }
      },
    });
    if (selected === trigger && host === container) {
      busy = false;
      root.querySelectorAll('[data-attribution-id]').forEach(button => { button.disabled = false; });
    }
  }
  const click = event => { const trigger = event.target.closest?.('[data-attribution-id]'); if (trigger && root.contains(trigger)) void show(trigger); };
  const keydown = event => { if (event.key === 'Escape' && selected) { event.preventDefault(); event.stopPropagation(); clear(); } };
  root.addEventListener('click',click); window.addEventListener('keydown',keydown,true);
  const retire = () => { disposed = true; clear(false); current.dispose(); root.removeEventListener('click',click); window.removeEventListener('keydown',keydown,true); window.removeEventListener('doctorcre-session-invalidated',retire); };
  window.addEventListener('doctorcre-session-invalidated',retire);
  return {dispose:retire};
}
