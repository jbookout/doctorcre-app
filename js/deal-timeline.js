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
  const changes = [...(detail.history || [])];
  if (detail.deal.phase_change) changes.push({...detail.deal.phase_change,field:'phase',new_value:detail.deal.phase_change.phase});
  for (const event of changes.sort((a,b) => Date.parse(a.recorded_at)-Date.parse(b.recorded_at))) {
    if (event.field !== 'phase') continue;
    const value = event.new_value?.phase ?? event.new_value;
    const column = columnBySlug(value) || columnByValue(value);
    const day = calendarDay(event.recorded_at);
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

export function renderPhaseTimeline(detail) {
  return `<div class="phase-scroll"><ol class="phase-rail" data-detail-read="phase" aria-label="Deal phases">${dealTimeline(detail).phases.map(p => `<li${p.current ? ' aria-current="step"' : ''}><span>${esc(p.label)}</span><time datetime="${esc(p.day || '')}">${esc(dateCaption(p.day))}</time></li>`).join('')}</ol></div>`;
}
export function renderCriticalDates(detail, now = Date.now()) {
  const view = dealTimeline(detail,now);
  return `<section class="critical-dates" data-detail-read="dates" aria-label="Critical dates">${view.dates.map(d => {
    const count = countdown(d,now);
    return `<article class="critical-date" data-date-id="${esc(d.id)}" data-state="${count.state}"><span>${esc(d.label)}</span><strong data-countdown="${esc(d.day)}" data-deadline="${Boolean(d.deadline)}" data-date-status="${esc(d.status || '')}">${esc(count.text)}</strong><time datetime="${esc(d.day)}">${esc(dateCaption(d.day))}</time>${d.original || d.evidence ? `<details><summary data-detail-focus="date-original:${esc(d.id)}">Details</summary><p class="note-original">${esc(d.original || d.evidence)}</p></details>` : ''}</article>`;
  }).join('')}${view.missing.map(d => `<button class="critical-date add-date" type="button" data-add-date="${d.kind}"><span>${esc(d.label)}</span><strong>＋ Add date</strong></button>`).join('')}</section>`;
}

export function renderDealTimeline(detail, now = Date.now(), full = false) {
  const view = dealTimeline(detail,now);
  const start = Date.parse(view.today)-30*DAY, end = Date.parse(view.today)+90*DAY;
  const all = [...view.dates.map(d => ({...d,type:'date',summary:d.label})),...view.entries.filter(e => e.day)];
  const shown = all.filter(e => full || Date.parse(e.day) >= start && Date.parse(e.day) <= end);
  const min = full ? Math.min(start,...all.map(e => Date.parse(e.day))) : start;
  const max = full ? Math.max(end,...all.map(e => Date.parse(e.day))) : end;
  const x = day => 40 + (Date.parse(day)-min)/(max-min)*920;
  const ticks = Array.from({length:5},(_,i) => new Date(min+(max-min)*i/4).toISOString().slice(0,10));
  const days = [...new Set(shown.map(e => e.day))].sort();
  const clusters = [];
  for (const day of days) {
    const last = clusters.at(-1);
    if (last && x(day)-x(last[0]) < 28) last.push(day); else clusters.push([day]);
  }
  const chart = `<div class="timeline-viewport"><svg class="timeline-chart" viewBox="0 0 1000 180" role="img" aria-label="Calendar timeline from ${esc(dateCaption(ticks[0]))} to ${esc(dateCaption(ticks.at(-1)))}"><line class="timeline-baseline" x1="40" x2="960" y1="58" y2="58"/><line class="timeline-baseline" x1="40" x2="960" y1="98" y2="98"/>${ticks.map(day => `<line class="timeline-grid" x1="${x(day)}" x2="${x(day)}" y1="35" y2="124"/><text x="${x(day)}" y="164" text-anchor="middle">${esc(dateCaption(day))}</text>`).join('')}<text x="40" y="46">Dates</text><text x="40" y="88">Activity</text><line class="timeline-today" x1="${x(view.today)}" x2="${x(view.today)}" y1="30" y2="138"/><text class="timeline-today-label" x="${x(view.today)}" y="20" text-anchor="middle">Today</text>${clusters.map(cluster => {
    const items = shown.filter(e => cluster.includes(e.day));
    const dates = items.filter(e => e.type === 'date').length, activity = items.length-dates;
    const cx = x(cluster[0]);
    return `<g><title>${esc(cluster.map(dateCaption).join(', '))}</title>${dates ? `<path class="timeline-point" d="M${cx} 48 l10 10 l-10 10 l-10 -10z"/><text class="timeline-count" x="${cx}" y="62" text-anchor="middle">${dates}</text>`:''}${activity ? `<circle class="timeline-point" cx="${cx}" cy="98" r="11"/><text class="timeline-count" x="${cx}" y="102" text-anchor="middle">${activity}</text>`:''}</g>`;
  }).join('')}</svg></div>`;
  const card = e => `<article class="deal-note timeline-entry" data-id="${esc(e.id)}" data-kind="${esc(e.type)}" data-detail-focus="entry:${esc(e.id)}" tabindex="0"><div class="timeline-entry-top"><b>${esc(e.type.replace(/[_-]+/g,' '))}</b>${e.day ? `<time datetime="${esc(e.day)}">${esc(dateCaption(e.day))}</time>` : '<span>Undated</span>'}</div><p>${esc(e.summary)}</p>${e.actor ? `<span class="timeline-actor">${esc(ACTOR_LABEL[e.actor] || e.actor)}</span>` : ''}<details><summary data-detail-focus="entry-original:${esc(e.id)}">Details</summary><p class="note-original">${esc(e.original || 'Original unavailable')}</p></details></article>`;
  return `<section class="deal-timeline" data-detail-read="timeline" aria-label="Deal timeline"><div class="timeline-heading"><h3>Timeline</h3><label><span class="sr-only">Timeline range</span><select id="timelineRange"><option value="recent"${!full ? ' selected':''}>Recent &amp; upcoming</option><option value="full"${full ? ' selected':''}>Full timeline</option></select></label></div>${chart}<div class="timeline-date-links">${days.map(day => `<button type="button" data-timeline-day="${esc(day)}" data-detail-focus="day:${esc(day)}">${esc(dateCaption(day))}</button>`).join('')}</div><div class="timeline-entries">${view.entries.filter(e => !e.day || full || Date.parse(e.day)>=start && Date.parse(e.day)<=end).map(card).join('') || '<p>No entries</p>'}</div></section>`;
}
export function updateCountdowns(root, now = Date.now()) {
  for (const node of root.querySelectorAll('[data-countdown]')) {
    const value = countdown({day:node.dataset.countdown,deadline:node.dataset.deadline === 'true',status:node.dataset.dateStatus},now);
    node.textContent = value.text; node.closest('.critical-date').dataset.state = value.state;
  }
}
