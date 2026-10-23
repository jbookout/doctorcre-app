import { COLUMNS, columnBySlug, columnByValue, noteText } from './pipeline-model.js';
import { escapeText } from './change-receipts.mjs';
import { concise, noteEntries } from './local-deals-model.js';
import { ACTOR_LABEL } from './client.js';

const DAY = 86400000;
const esc = escapeText;
// Wire kinds, never prose matching or dates inferred from lease duration.
export const DATE_KINDS = Object.freeze([
  { kind:'loi_expiry', label:'LOI', kinds:['loi_expiry','loi','loi_due'], deadline:true },
  { kind:'due_diligence', label:'Due diligence', kinds:['due_diligence','due_diligence_deadline','dd_deadline'], deadline:true },
  { kind:'lease_commencement', label:'Lease commencement', kinds:['lease_commencement','commencement'] },
  { kind:'lease_expiration', label:'Lease expiration', kinds:['lease_expiration'], deadline:true },
  { kind:'rent_start', label:'Rent start', kinds:['rent_start','rent_commencement'] },
  { kind:'option_window', label:'Options', kinds:['option_window','option_notice','option_exercise'], deadline:true },
]);
export function calendarDay(value) {
  if (typeof value !== 'string') return null;
  const day = value.slice(0,10);
  if (!/^\d{4}-\d\d-\d\d$/.test(day)) return null;
  const stamp = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === day ? day : null;
}
const today = now => {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
};
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
export function dealTimeline(detail, now = Date.now()) {
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
    recordedDates.unshift({id:`lease-${lease.id}-commencement`,kind:'lease_commencement',due_on:lease.commencement_on,note:lease.evidence_ref,source:lease.source});
    recordedDates.push({id:`lease-${lease.id}-expiration`,kind:'lease_expiration',due_on:lease.expiration_on,note:lease.evidence_ref,source:lease.source});
  }
  const rows = recordedDates.filter(row => calendarDay(row.due_on || row.date)).map((row,i) => {
    const definition = DATE_KINDS.find(d => d.kinds.includes(row.kind));
    return {id:row.id || `date-${i}`,kind:definition?.kind || row.kind,label:definition?.label || row.label || row.kind?.replace(/[_-]+/g,' ') || 'Date',
      day:calendarDay(row.due_on || row.date),original:noteText(row.note),evidence:row.source || '',status:row.status,deadline:Boolean(definition?.deadline)};
  });
  // Co-located dates share a card, preserving every original and status.
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.kind}|${row.day}|${row.status || ''}`;
    const existing = grouped.get(key);
    const references = [row.original,row.evidence].filter(Boolean);
    if (existing) existing.references.push(...references);
    else grouped.set(key,{...row,references});
  }
  const dates = [...grouped.values()].map(({references,...row}) => ({...row,
    original:[...new Set(references)].join('\n\n')})).sort((a,b) => a.day.localeCompare(b.day));
  const missing = DATE_KINDS.filter(d => !dates.some(row => row.kind === d.kind));
  const entries = noteEntries(detail).map(e => ({...e, day:calendarDay(e.when),type:e.kind}));
  for (const doc of detail.documents || []) entries.push({id:`document-${doc.id}`,type:'Document',kind:'Document',
    day:calendarDay(doc.prepared_at),when:doc.prepared_at,summary:concise(doc.note || 'Document prepared',150),original:noteText(doc.note)});
  entries.sort((a,b) => (a.day || '9999').localeCompare(b.day || '9999') || a.id.localeCompare(b.id));
  return {phases,dates,missing,entries,today:today(now)};
}

export function renderCriticalDates(detail, now = Date.now()) {
  const view = dealTimeline(detail,now);
  return `<section class="critical-dates" data-detail-read="dates" aria-label="Critical dates">${view.dates.map(d => {
    const count = countdown(d,now);
    return `<article class="critical-date" data-date-id="${esc(d.id)}" data-state="${count.state}"><span>${esc(d.label)}</span><strong data-countdown="${esc(d.day)}" data-deadline="${Boolean(d.deadline)}" data-date-status="${esc(d.status || '')}">${esc(count.text)}</strong><time datetime="${esc(d.day)}">${esc(dateCaption(d.day))}</time>${d.original || d.evidence ? `<details><summary data-detail-focus="date-original:${esc(d.id)}">Details</summary><p class="note-original">${esc(d.original || d.evidence)}</p></details>` : ''}</article>`;
  }).join('')}${view.missing.map(d => `<button class="critical-date add-date" type="button" data-add-date="${d.kind}"><span>${esc(d.label)}</span><strong>＋ Add date</strong></button>`).join('')}</section>`;
}

export function renderDealTimeline(detail, now = Date.now()) {
  const view = dealTimeline(detail,now);
  return `<section class="deal-timeline" data-detail-read="timeline" aria-label="Deal phases and timeline"><h3>Phase timeline</h3><ol class="phase-rail">${view.phases.map(p => `<li${p.current ? ' aria-current="step"' : ''}><span>${esc(p.label)}</span>${p.day ? `<time datetime="${esc(p.day)}">${esc(dateCaption(p.day))}</time>` : ''}</li>`).join('')}</ol></section>`;
}
export function renderDealUpdates(detail, now = Date.now()) {
  const held = (detail.next_actions || []).filter(task => task.status === 'open' && calendarDay(task.hold_until) > today(now))
    .map(task => ({id:`action:${task.id}`,kind:`Held until ${dateCaption(calendarDay(task.hold_until))}`,
      actor:task.owner,when:task.updated_at,summary:task.description,original:task.description}));
  const entries = [...noteEntries(detail), ...held].sort((a,b) => (Date.parse(b.when) || 0)-(Date.parse(a.when) || 0) || String(b.id).localeCompare(String(a.id)));
  if (!entries.length) return '';
  const stamp = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}) : 'Date not recorded';
  };
  const overview = concise(entries[0]?.summary, 72);
  return `<section class="deal-updates" data-detail-read="updates" aria-label="Deal updates"><h3>Updates</h3>${entries.length ? `<div class="updates-overview"><p aria-label="Latest recorded update">${esc(overview)}</p></div><details class="updates-history"><summary data-detail-focus="update-history">Recorded updates (${entries.length})</summary>${(detail.activities || []).length >= 50 ? '<p class="updates-scope">Includes the latest 50 activities; older activities may be omitted.</p>' : ''}${entries.map(e => `<article class="deal-note" data-id="${esc(e.id)}" data-kind="${esc(e.kind)}"><div class="timeline-entry-top"><b>${esc(ACTOR_LABEL[e.actor] || (e.actor === 'joe-local' ? 'Joe' : e.actor) || 'Author not recorded')}</b><time datetime="${esc(e.when || '')}">${esc(stamp(e.when))}</time></div><small>${esc(e.kind)}</small><p>${esc(e.summary)}</p>${e.original && e.original !== e.summary ? `<details><summary data-detail-focus="entry-original:${esc(e.id)}">Read full update</summary><p class="note-original">${esc(e.original)}</p></details>` : ''}</article>`).join('')}</details>` : '<p>No updates recorded.</p>'}</section>`;
}
export function updateCountdowns(root, now = Date.now()) {
  for (const node of root.querySelectorAll('[data-countdown]')) {
    const value = countdown({day:node.dataset.countdown,deadline:node.dataset.deadline === 'true',status:node.dataset.dateStatus},now);
    node.textContent = value.text; node.closest('.critical-date').dataset.state = value.state;
  }
}
