import { COMPARISON_ROWS } from './terms-comparison-fields.mjs';
import { fetchRead } from './current-read.mjs';

export async function prepareComparisonHttp(fetchImpl, args, csrf, timeoutMs, signal) {
  const response = await fetchRead('/api/v1/fact-review/comparison', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'content-type': 'application/json', 'x-carr-csrf': csrf }, body: JSON.stringify(args),
  }, { fetchImpl, timeoutMs });
  let payload;
  try { payload = await response.json(); } catch { /* An unreadable write response has an unknown outcome. */ }
  if (!response.ok) {
    const error = Object.assign(new Error('Terms comparison request failed.'), { status: response.status });
    if (response.status === 400 && ['comparison_fact_blocked', 'comparison_template_unavailable', 'validation_error', 'not_found'].includes(payload?.error)) error.payload = payload;
    throw error;
  }
  if (payload?.ok !== true || payload.schema_version !== 'terms-comparison.v1' || payload.status !== 'draft'
    || typeof payload.document_id !== 'string' || payload.template?.slug !== 'loi-grid'
    || typeof payload.template.name !== 'string' || typeof payload.human_gate !== 'string'
    || !Array.isArray(payload.edits) || !payload.edits.every(edit => typeof edit.where === 'string' && typeof edit.text === 'string')
    || !Array.isArray(payload.remaining) || !payload.remaining.every(text => typeof text === 'string'))
    throw new Error('Terms comparison receipt unavailable.');
  const edits = new Map(payload.edits.map(edit => [edit.where, edit.text]));
  const required = ['A1', ...args.fields.flatMap(field => ['A', 'B', 'C'].map(column => `${column}${COMPARISON_ROWS[field.fact_key]}`))];
  if (required.some(cell => !edits.get(`cell:LOI Grid!${cell}`))
    || edits.get('cell:LOI Grid!B4') !== 'Prior - Confirmed deal fact'
    || edits.get('cell:LOI Grid!C4') !== 'Current - Confirmed deal fact')
    throw new Error('Terms comparison fill fields unavailable.');
  return payload;
}
