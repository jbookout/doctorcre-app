import { escapeText as esc } from './change-receipts.mjs';
import { dateCaption } from './deal-timeline.js';

const STATUS = { complete: 'Recorded complete', received: 'Received', not_recorded: 'Not recorded', due: 'Due today', overdue: 'Overdue', upcoming: 'Upcoming' };

export function renderDealChecklist(checklist) {
  if (!checklist) return '';
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const row = item => item && text(item.id) && text(item.label) && typeof item.status === 'string' && Object.hasOwn(STATUS, item.status)
    && (item.due_on == null || typeof item.due_on === 'string');
  const optionalText = value => value == null || typeof value === 'string';
  const sourceRefs = source => [source.document, source.request, source.record_verb];
  const valid = Array.isArray(checklist.phases) && checklist.phases.every(phase => phase
    && text(phase.label) && Array.isArray(phase.items) && phase.items.every(item => row(item)
      && optionalText(item.evidence_ref) && item.source
      && sourceRefs(item.source).every(optionalText) && sourceRefs(item.source).some(text)
      && (optionalText(item.source.version) || Number.isFinite(item.source.version))))
    && Array.isArray(checklist.due_items) && checklist.due_items.every(item => row(item) && text(item.due_on));
  const unavailable = checklist.template_state === 'unavailable';
  const unsupported = checklist.schema_version !== 'deal-checklist.v1';
  const sourceChanged = checklist.template_state === 'source_changed';
  if (unavailable || unsupported || sourceChanged || !valid) {
    const message = unavailable ? 'Requirements could not be read.' : sourceChanged && !unsupported ? 'Checklist needs a doctrine review.' : 'Checklist unavailable.';
    return `<section class="deal-checklist" aria-label="Deal checklist"><h3>Deal checklist</h3><p role="status">${message}</p>${!sourceChanged || unavailable || unsupported ? '<button class="btn" type="button" data-refresh-detail data-detail-focus="checklist">Refresh deal</button>' : ''}</section>`;
  }
  if (!checklist.phases.some(phase => phase.items.length)) return '';
  const due = checklist.due_items.length;
  const next = checklist.due_items[0];
  return `<details class="deal-checklist"><summary data-detail-focus="checklist"><span>Deal checklist${due ? ` · ${due} due` : ''}</span>${next ? `<span class="checklist-next"><strong>${esc(next.label)}</strong><span>${esc(STATUS[next.status])} · <time datetime="${esc(next.due_on)}">${esc(dateCaption(next.due_on))}</time></span></span>` : ''}</summary>
    ${checklist.template_state === 'deal_type_unknown' ? '<p>Confirm the deal type to see its full checklist.</p>' : ''}
    ${checklist.phases.map(phase => `<section><h3>${esc(phase.label)}</h3><ul>${phase.items.map(item => `<li data-checklist-item="${esc(item.id)}" data-state="${esc(item.status)}"><span>${esc(item.label)}</span><strong>${esc(STATUS[item.status])}</strong>${item.due_on ? `<time datetime="${esc(item.due_on)}">${esc(dateCaption(item.due_on))}</time>` : ''}<details><summary>Evidence and source</summary><p>${esc(item.evidence_ref || 'No completion evidence recorded.')}</p><p>${esc(sourceRefs(item.source).find(text))}${item.source.version ? ` · version ${esc(item.source.version)}` : ''}</p></details></li>`).join('')}</ul></section>`).join('')}
  </details>`;
}
