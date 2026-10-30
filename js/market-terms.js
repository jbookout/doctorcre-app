import { escapeText as esc } from './change-receipts.mjs';
import { invoiceMoney } from './invoice-tracker-model.js';

export function mountMarketTerms(root, { deal, read }) {
  root.innerHTML = `<h2>Compare terms</h2><p>Confirmed terms from recorded firm history. This is not a complete market survey.</p><form class="market-filters"><label>Submarket<input name="submarket" maxlength="200" value="${esc(deal.submarket || '')}"></label><label>Use type<input name="use_type" maxlength="200" value="${esc(deal.use_type || '')}"></label><button class="btn" type="submit">Compare</button></form><div data-market-results role="status"></div>`;
  const form = root.querySelector('form');
  const result = root.querySelector('[data-market-results]');
  let sequence = 0;
  async function load() {
    const current = ++sequence;
    result.textContent = 'Loading comparable terms…';
    const args = Object.fromEntries(['submarket','use_type'].map(name => [name, form.elements[name].value.trim()]).filter(([,value]) => value));
    try {
      const data = await read(args);
      if (current !== sequence) return;
      if (!data?.ok || data.schema_version !== 'market-terms.v1' || !Array.isArray(data.rows) || !data.coverage) throw new Error('Invalid response');
      const c = data.coverage;
      const coverage = `<p><strong>${data.rows.length} comparable ${data.rows.length === 1 ? "term" : "terms"} across ${esc(c.comparable_deals)} ${c.comparable_deals === 1 ? "deal" : "deals"}.</strong></p><p>Firm-wide history coverage (not filtered): ${esc(c.eligible_receipts)} of ${esc(c.canonical_receipts)} receipts eligible; ${esc(c.unsupported_receipts)} unsupported, ${esc(c.superseded_without_context)} superseded without context, ${esc(c.unclassified_receipts)} unclassified. From ${esc(c.recorded_documents)} recorded documents. Archive coverage is unknown.</p>`;
      if (!data.rows.length) { result.innerHTML = `${coverage}<p>No comparable terms match these filters.</p>`; return; }
      const rows = data.rows.map(row => {
        const superseded = row.effective_to && row.effective_to <= new Date().toISOString().slice(0, 10) && data.rows.some(next => next.entity_ref === row.entity_ref && next.fact_key === row.fact_key && next.term_kind === row.term_kind && next.effective_from === row.effective_to);
        const number = Number(row.value);
        const value = /^USD/i.test(row.unit || '') && row.value !== '' && Number.isFinite(number) ? invoiceMoney(number) : row.value;
        const source = (row.sources || []).map(s => `${s.document_ref}${s.page_start ? `, p. ${s.page_start}${s.page_end && s.page_end !== s.page_start ? `–${s.page_end}` : ''}` : ''}`).join('; ') || row.context_source?.document_ref || 'Source unavailable';
        return `<tr${superseded ? ' class="superseded"' : ''}><td data-label="Date">${esc(row.term_date)}</td><td data-label="Deal"><a href="/deals?deal=${encodeURIComponent(row.entity_ref)}">${esc(row.entity_ref)}</a></td><td data-label="Stage">${esc(row.term_kind)}</td><td data-label="Term">${esc(row.fact_key)}: ${esc(value)} ${esc(/^USD/i.test(row.unit || '') && Number.isFinite(number) ? row.unit.replace(/^USD/i, '') : (row.unit || ''))}</td><td data-label="Expense basis">${esc(row.expense_basis || 'Not recorded')}</td><td data-label="Confidence">${esc((row.confidence || '').replaceAll('_',' '))}</td><td data-label="Effective period">${esc(row.effective_from)} to ${esc(row.effective_to || 'present')}${superseded ? ' · superseded' : ''}</td><td data-label="Source">${esc(source)}</td></tr>`;
      }).join('');
      result.innerHTML = `${coverage}<table class="market-terms-table"><thead><tr><th>Date</th><th>Deal</th><th>Stage</th><th>Term</th><th>Expense basis</th><th>Confidence</th><th>Effective period</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>`;
    } catch (error) {
      if (current !== sequence) return;
      result.textContent = error.status === 404 || error.code === 'unknown_tool' ? 'Term comparison is unavailable until the server update is deployed.' : 'Could not load comparable terms. Try again.';
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void load(); });
  void load();
}
