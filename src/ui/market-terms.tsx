import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useEffect, useRef, useState, type FormEvent } from 'react';

type Row = { entity_ref: string; fact_key: string; value: string; unit?: string | null; term_kind: string; term_date: string; effective_from: string; effective_to?: string | null; expense_basis?: string | null; confidence?: string | null; sources?: { document_ref: string; page_start?: number | null; page_end?: number | null; quarantined?: boolean }[]; context_source?: { document_ref: string } | null };
type Coverage = { comparable_deals: number; canonical_receipts: number; recorded_documents: number; eligible_receipts?: number | null; unsupported_receipts: number; superseded_without_context?: number | null; unclassified_receipts: number };
type Response = { ok: boolean; schema_version: string; rows: Row[]; coverage: Coverage };
type Options = { client: { readMarketTerms(args: { submarket?: string; use_type?: string; as_of?: string }): Promise<unknown> }; entityRef: string; submarket?: string; useType?: string; dealName?: (entityRef: string) => string | null | undefined };
type View = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: Response; asOf: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isResponse(value: unknown): value is Response {
  if (!isRecord(value) || value.ok !== true || value.schema_version !== 'market-terms.v1' || !Array.isArray(value.rows) || !isRecord(value.coverage)) return false;
  const coverage = value.coverage;
  if (!['comparable_deals', 'canonical_receipts', 'recorded_documents', 'unsupported_receipts', 'unclassified_receipts'].every(key => isCount(coverage[key]))) return false;
  if (!['eligible_receipts', 'superseded_without_context'].every(key => coverage[key] == null || isCount(coverage[key]))) return false;
  return value.rows.every(row => {
    if (!isRecord(row)) return false;
    if (!['entity_ref', 'fact_key', 'value', 'term_kind', 'term_date', 'effective_from'].every(key => typeof row[key] === 'string')) return false;
    if (!['unit', 'effective_to', 'expense_basis', 'confidence'].every(key => row[key] == null || typeof row[key] === 'string')) return false;
    if (row.context_source != null && (!isRecord(row.context_source) || typeof row.context_source.document_ref !== 'string')) return false;
    if (row.sources === undefined) return true;
    return Array.isArray(row.sources) && row.sources.every(source => isRecord(source)
      && typeof source.document_ref === 'string'
      && ['page_start', 'page_end'].every(key => source[key] == null || isCount(source[key]))
      && (source.quarantined === undefined || typeof source.quarantined === 'boolean'));
  });
}

function Comparison({ client, submarket = '', useType = '', dealName, refreshRef }: Options & { refreshRef: { current: () => void } }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const form = useRef<HTMLFormElement>(null);
  const sequence = useRef(0);
  async function load() {
    const current = ++sequence.current;
    const element = form.current;
    if (!element) return;
    const fields = new FormData(element);
    const asOf = String(fields.get('as_of') || '');
    if (!element.checkValidity() || (asOf && (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf < '0001-01-01' || !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString().slice(0, 10) !== asOf))) {
      setView({ kind: 'error', message: 'Enter a valid business date or leave it blank for all recorded history.' });
      return;
    }
    setView({ kind: 'loading' });
    const submarket = String(fields.get('submarket') || '').trim();
    const use_type = String(fields.get('use_type') || '').trim();
    try {
      const data = await client.readMarketTerms({ ...(submarket && { submarket }), ...(use_type && { use_type }), ...(asOf && { as_of: asOf }) });
      if (current !== sequence.current) return;
      if (!isResponse(data)) throw new Error('Invalid response');
      setView({ kind: 'ready', data, asOf });
    } catch (error: unknown) {
      if (current !== sequence.current) return;
      const unavailable = typeof error === 'object' && error !== null && (('status' in error && error.status === 404) || ('code' in error && error.code === 'unknown_tool'));
      setView({ kind: 'error', message: unavailable ? 'Term comparison is unavailable until the server update is deployed.' : 'Could not load comparable terms. Try again.' });
    }
  }
  refreshRef.current = () => { void load(); };
  useEffect(() => { void load(); return () => { sequence.current++; }; }, []);
  function submit(event: FormEvent) { event.preventDefault(); void load(); }
  return <><h2>Compare terms</h2><p>Confirmed terms from recorded firm history. This is not a complete market survey.</p><form className="market-filters" ref={form} onSubmit={submit}><label>Submarket<input name="submarket" maxLength={200} defaultValue={submarket} /></label><label>Use type<input name="use_type" maxLength={200} defaultValue={useType} /></label><label>As of date (optional)<input name="as_of" type="date" min="0001-01-01" max="9999-12-31" aria-describedby="market-date-help" /></label><button className="btn" type="submit">Compare</button></form><p id="market-date-help">Leave the date blank for all recorded history.</p><div data-market-results role="status">{view.kind === 'loading' ? 'Loading comparable terms…' : view.kind === 'error' ? view.message : <Results data={view.data} asOf={view.asOf} dealName={dealName} />}</div></>;
}
function Results({ data, asOf, dealName }: { data: Response; asOf: string; dealName?: Options['dealName'] }) {
  const c = data.coverage;
  return <><p><strong>{asOf ? `Terms as of ${asOf}` : 'All recorded history'}</strong></p><p><strong>{data.rows.length} comparable {data.rows.length === 1 ? 'term' : 'terms'} across {c.comparable_deals} {c.comparable_deals === 1 ? 'deal' : 'deals'}.</strong></p><details><summary>Firm-wide coverage (not filtered)</summary><p>{c.eligible_receipts == null ? '' : `${c.eligible_receipts} of `}{c.canonical_receipts} receipts{c.eligible_receipts == null ? '' : ' eligible'}; {c.unsupported_receipts} unsupported{c.superseded_without_context == null ? '' : `, ${c.superseded_without_context} superseded without context`}, {c.unclassified_receipts} unclassified. From {c.recorded_documents} recorded documents. Archive coverage is unknown.</p></details>{!data.rows.length ? <p>No comparable terms match these filters.</p> : <table className="market-terms-table"><thead><tr>{['Date','Deal','Stage','Term','Expense basis','Confidence','Effective period','Source'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{data.rows.map((row, index) => {
    const superseded = row.effective_to && (!asOf || row.effective_to <= asOf) && data.rows.some(next => next.entity_ref === row.entity_ref && next.fact_key === row.fact_key && next.term_kind === row.term_kind && next.effective_from === row.effective_to);
    const number = Number(row.value), usd = /^USD/i.test(row.unit || ''), value = usd && row.value !== '' && Number.isFinite(number) ? new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',maximumFractionDigits:2}).format(number) : row.value;
    const sources = row.sources || [];
    return <tr key={index} className={superseded ? 'superseded' : undefined}><td data-label="Date">{row.term_date}</td><td data-label="Deal"><a href={`/deals?deal=${encodeURIComponent(row.entity_ref)}`}>{dealName?.(row.entity_ref) || 'Name not available'}</a></td><td data-label="Stage">{row.term_kind}</td><td data-label="Term">{row.fact_key}: {value}{usd && Number.isFinite(number) ? (row.unit || '').replace(/^USD/i, '') : row.unit ? ` ${row.unit}` : ''}</td><td data-label="Expense basis">{row.expense_basis || 'Not recorded'}</td><td data-label="Confidence">{(row.confidence || '').replaceAll('_',' ')}</td><td data-label="Effective period">{row.effective_from} to {row.effective_to || 'present'}{superseded ? ' · superseded' : ''}</td><td data-label="Source">{sources.length ? sources.map((source, index) => <span key={index}>{index > 0 && '; '}{source.document_ref}{source.page_start ? `, p. ${source.page_start}${source.page_end && source.page_end !== source.page_start ? `–${source.page_end}` : ''}` : ''}{source.quarantined && <strong> — Quarantined: not supporting evidence</strong>}</span>) : row.context_source?.document_ref || 'Source unavailable'}</td></tr>;
  })}</tbody></table>}</>;
}
export function mountMarketTerms(root: HTMLElement, options: Options) {
  const reactRoot = createRoot(root), refreshRef = { current: () => {} };
  flushSync(() => reactRoot.render(<Comparison {...options} refreshRef={refreshRef} />));
  return { refresh: () => refreshRef.current(), dispose: () => reactRoot.unmount() };
}
