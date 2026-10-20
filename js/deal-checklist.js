import { escapeText as esc } from './change-receipts.mjs';
import { dateCaption } from './deal-timeline.js';

const STATUS = { complete: 'Recorded complete', not_recorded: 'Not recorded', due: 'Due today', overdue: 'Overdue', upcoming: 'Upcoming' };

export function renderDealChecklist(checklist) {
  if (!checklist) return '';
  const unavailable = checklist.schema_version !== 'deal-checklist.v1';
  if (unavailable || checklist.template_state === 'source_changed') {
    return `<section class="deal-checklist" data-detail-read="checklist" aria-label="Deal checklist"><h3>Deal checklist</h3><p>${unavailable ? 'Checklist unavailable.' : 'Checklist needs a doctrine review.'}</p></section>`;
  }
  if (!checklist.phases.some(phase => phase.items.length)) return '';
  const due = checklist.due_items.length;
  return `<details class="deal-checklist" data-detail-read="checklist"><summary>Deal checklist${due ? ` · ${due} due` : ''}</summary>
    ${checklist.template_state === 'deal_type_unknown' ? '<p>Confirm the deal type to see its full checklist.</p>' : ''}
    ${due ? `<p role="status">${due} checklist item${due === 1 ? '' : 's'} due. Review the dates below.</p>` : ''}
    ${checklist.phases.map(phase => `<section><h3>${esc(phase.label)}</h3><ul>${phase.items.map(item => `<li data-checklist-item="${esc(item.id)}" data-state="${esc(item.status)}"><span>${esc(item.label)}</span><strong>${esc(STATUS[item.status] || 'Not recorded')}</strong>${item.due_on ? `<time datetime="${esc(item.due_on)}">${esc(dateCaption(item.due_on))}</time>` : ''}<details><summary>Evidence and source</summary><p>${esc(item.evidence_ref || 'No completion evidence recorded.')}</p><p>${esc(item.source.document || item.source.request || item.source.record_verb)}${item.source.version ? ` · version ${esc(item.source.version)}` : ''}</p></details></li>`).join('')}</ul></section>`).join('')}
  </details>`;
}
