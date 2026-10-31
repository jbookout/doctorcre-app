import { useState, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Document = { id: string; display_name: string; stored_at: string };
type Period = { start_month: number; end_month: number; rate: string; unit: string; expense_basis: string; escalation_percent: string | null };
type SourcedPeriod = { [K in keyof Period]: { value: Period[K] } };
type Value = { value: string | SourcedPeriod[]; normalized_schedule?: Period[]; unit: string; normalized_value?: string; canonical_unit?: string; expense_basis?: string | null; observation_ids?: string[] };
type Observation = Value & { id: string; method: string; confidence_tier: string; source: { document_ref: string; page_start: number; page_end: number; cited_text: string | null; cited_text_expires_at: string } };
type Item = { entity_ref: string; fact_key: string; pending: boolean; priority?: string; reasons: string[]; canonical_fact: Value | null; observations: Observation[]; review_history: { decision: string; reason: string }[]; canonical_version: number; canonical_history: { version: number; promoted_at?: string }[]; review_version: string };
type HumanFact = { fact_key: string; value: string; unit: string; expense_basis?: string; source: { document_ref: string; page_start: number; page_end: number; cited_text: string } };
type Args = { idempotency_key: string; entity_ref: string } & ({ observation: HumanFact } | { fact_key: string; base_version: number; review_version: string; decision: string; reason: string; observation_id?: string; correction?: HumanFact });
type Receipt = { ok: boolean; schema_version: string };
type Client = { prepareTermsComparison(args: ComparisonRequest): Promise<Plan>; listDealDocuments(args: { deal_id: string; limit: number; cursor?: string }): Promise<{ ok: boolean; schema_version: string; documents: Document[]; has_more: boolean; next_cursor: string | null }>; listFactReview(args: { entity_ref: string; include_resolved: boolean; limit: number; cursor?: string }): Promise<{ schema_version: string; items: Item[]; has_more: boolean; next_cursor: string | null }>; recordHumanFact(args: Args): Promise<Receipt>; resolveFactReview(args: Args): Promise<Receipt> };
type ComparisonField = { fact_key: string; prior_version: number; current_version: number };
type ComparisonRequest = { idempotency_key: string; deal_id: string; fields: ComparisonField[] };
type Plan = { template: { name: string }; human_gate: string; edits: { where: string; text: string }[]; remaining: string[] };
type Options = { client: Client; entityRef: string; terms: Record<string, { label: string; units: Record<string, number> }> };
type Controls = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;
const BASES: Record<string, string> = { nnn: 'NNN', modified_gross: 'Modified gross', full_service_gross: 'Full service gross', gross: 'Gross' };
function valueText(value: Value) {
  if (value.unit === 'schedule' || value.canonical_unit === 'schedule') return 'Rent schedule';
  const amount = value.canonical_unit ? value.normalized_value : value.value;
  const unit = value.canonical_unit || value.unit;
  const units: Record<string, string> = { 'USD/SF/year': '/SF/yr', 'USD/SF/month': '/SF/mo', 'USD/SF': '/SF', USD: '' };
  const formatted = Object.hasOwn(units, unit) ? `$${String(amount).replace(/^\d+/, integer => integer.replace(/\B(?=(\d{3})+(?!\d))/g, ','))}${units[unit]}` : `${amount} ${unit}`;
  return `${formatted}${value.expense_basis ? ` · ${BASES[value.expense_basis] || value.expense_basis}` : ''}`;
}
function readLabel(o: Observation) {
  const method = ({ text_layer: 'Text', ocr: 'OCR', human: 'Typed by a partner' } as Record<string, string>)[o.method] || 'Read method unavailable';
  if (o.method === 'ocr') return 'OCR · verify';
  const confidence = ({ auto_accept: 'high', verify_band: 'verify', human_review: 'review' } as Record<string, string>)[o.confidence_tier];
  return confidence ? `${method} · ${confidence}` : method;
}
function reviewLabel(item: Item) {
  if (!item.pending) return 'Reviewed';
  return `${item.priority === 'high' ? 'High priority · ' : ''}${[...new Set(item.reasons.map(reason => ({ ocr_disagreement: 'OCR disagreement', unsupported_ocr: 'OCR could not read this', no_text_layer: 'No text layer', ambiguous: 'Ambiguous value', absent: 'Value not found', conflict: 'Conflicting values', verify_band: 'Verify confidence', human_review: 'Human review required' } as Record<string, string>)[reason] || 'Review required'))].join(' · ') || 'Review required'}`;
}
function documentName(o: Observation, documents: Document[]) { return documents.find(doc => doc.id === o.source.document_ref)?.display_name || 'Document name unavailable'; }
function Entry({ documents, factKey, prefix, terms }: { documents: Document[]; factKey?: string; prefix: string; terms: Options['terms'] }) {
  const [selectedTerm, setSelectedTerm] = useState(factKey || 'base_rent_per_sf');
  const units = Object.keys(terms[selectedTerm]?.units || {});
  return <div className="fact-entry">
    {!factKey && <label>Term<select aria-label="Term" name="fact_key" onChange={event => setSelectedTerm(event.currentTarget.value)}>{Object.entries(terms).map(([key, term]) => <option key={key} value={key}>{term.label}</option>)}</select></label>}
    <label>Value<input name="value" inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,29})(?:[.][0-9]{1,18})?" maxLength={49} required /></label>
    <label>Unit<select aria-label="Unit" name="unit" key={units.join("|")}>{units.map(unit => <option key={unit}>{unit}</option>)}</select></label>
    <label data-expense-basis hidden={selectedTerm !== 'base_rent_per_sf'}>Expense basis<select aria-label="Expense basis" name="expense_basis" disabled={selectedTerm !== 'base_rent_per_sf'}>{Object.entries(BASES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label className="fact-wide">Document<select aria-label="Document" name="document_ref" required>{documents.map(doc => <option key={doc.id} value={doc.id}>{doc.display_name} · {doc.stored_at.slice(0, 10)}</option>)}</select></label>
    <label>First page<input name="page_start" type="number" min="1" max="100000" defaultValue="1" required /></label>
    <label>Last page<input name="page_end" type="number" min="1" max="100000" defaultValue="1" required /></label>
    <label className="fact-wide">Cited text<textarea name="cited_text" rows={2} maxLength={4000} required aria-describedby={`${prefix}-source-hint`} /></label>
    <small id={`${prefix}-source-hint`} className="fact-wide">Transcribe the clause from the stored document. This entry does not verify the document text.</small>
  </div>;
}
function scheduleRate(p: Period) {
  const units: Record<string, string> = { 'USD/SF/year': '/SF/yr', 'USD/SF/month': '/SF/mo', 'USD/SF': '/SF', USD: '' };
  const [whole = '', fraction = ''] = String(p.rate).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}${units[p.unit] ?? ` ${p.unit}`}`;
}
function scheduleLabel(o: Observation) { return `Schedule ${o.id}`; }
function scheduleSummary(o: Observation) {
  return Array.isArray(o.value) ? sourcedPeriods(o.value).map(p => `${p.start_month}–${p.end_month} months: ${scheduleRate(p)}`).join('; ') : '';
}
function Schedule({ periods }: { periods: Period[] }) {
  return <table className="fact-schedule"><thead><tr><th>Period</th><th>Rate</th><th>Escalation</th><th>Expense basis</th></tr></thead><tbody>{periods.map((p, i) => {
    return <tr key={i}><td data-label="Period">{p.start_month}–{p.end_month} months</td><td data-label="Rate">{scheduleRate(p)}</td><td data-label="Escalation">{p.escalation_percent == null ? '—' : `${p.escalation_percent}%`}</td><td data-label="Expense basis">{BASES[p.expense_basis] ?? p.expense_basis}</td></tr>;
  })}</tbody></table>;
}
function sourcedPeriods(periods: SourcedPeriod[]): Period[] {
  return periods.map(p => ({ start_month: p.start_month.value, end_month: p.end_month.value, rate: p.rate.value, unit: p.unit.value, expense_basis: p.expense_basis.value, escalation_percent: p.escalation_percent.value }));
}
function Review({ item, documents, index, terms }: { item: Item; documents: Document[]; index: number; terms: Options['terms'] }) {
  const schedule = item.fact_key === 'rent_schedule';
  return <article className="fact-term" id={`term-${item.fact_key}`} tabIndex={-1} data-fact-key={item.fact_key}><header><h3>{terms[item.fact_key]?.label || item.fact_key.replaceAll('_', ' ')}</h3><span className="fact-state">{reviewLabel(item)}</span></header>
    <div className="fact-canonical"><small>Canonical value</small>{schedule && item.canonical_fact?.normalized_schedule ? <Schedule periods={item.canonical_fact.normalized_schedule} /> : <p className={item.canonical_fact ? undefined : 'fact-empty'}>{item.canonical_fact ? valueText(item.canonical_fact) : 'No canonical value recorded'}</p>}</div>
    <div className="fact-observations">{item.observations.map(o => <section key={o.id} className="fact-observation">{schedule && Array.isArray(o.value) ? <><strong>{scheduleLabel(o)}</strong><Schedule periods={sourcedPeriods(o.value)} /></> : <strong>{valueText(o)}</strong>}{item.canonical_fact?.observation_ids?.includes(o.id) && <span className="fact-state"> · Settled value</span>}<p className="fact-read">{readLabel(o)}</p><p className="fact-source">{documentName(o, documents)} · {o.source.page_start === o.source.page_end ? 'Page' : 'Pages'} {o.source.page_start}{o.source.page_start === o.source.page_end ? '' : `–${o.source.page_end}`}</p>{!o.source.cited_text || Date.parse(o.source.cited_text_expires_at) <= Date.now() ? <p className="fact-excerpt-unavailable">Excerpt no longer available</p> : <blockquote>{o.source.cited_text}</blockquote>}</section>)}</div>
    <button type="button" className="btn" data-review-term hidden={item.pending}>Review term</button>
    <form data-fact-review={index} hidden={!item.pending}>
      <label>Decision<select aria-label="Decision" name="decision" defaultValue={item.observations.length ? "approve" : "reject"}><option value="approve" disabled={!item.observations.length}>Approve a sourced value</option><option value="correct" disabled={!documents.length || schedule}>Correct with a source</option><option value="reject">Reject this review</option></select></label>
      <label data-choose-value hidden={!item.observations.length}>Choose a value<select aria-label="Choose a value" name="observation_id" required disabled={!item.observations.length}><option value="">Choose a sourced value</option>{item.observations.map(o => <option key={o.id} value={o.id}>{schedule ? `${scheduleLabel(o)} · ${scheduleSummary(o)}` : valueText(o)} · {documentName(o, documents)}{schedule ? ` · ${o.method === 'ocr' ? 'OCR' : o.method === 'text_layer' ? 'Text' : o.method} · Page ${o.source.page_start}${o.source.page_start === o.source.page_end ? '' : `–${o.source.page_end}`}` : ''}</option>)}</select></label>
      <fieldset data-correction hidden disabled><legend>Corrected term</legend>{!schedule && <Entry documents={documents} factKey={item.fact_key} prefix={`correction-${index}`} terms={terms} />}</fieldset>
      <label>Reason<textarea name="reason" rows={2} maxLength={2000} required /></label><button type="submit" className="btn btn-primary">Save review</button><p role="status" data-write-status />
    </form>
    {!!item.review_history.length && <details className="fact-history"><summary>Review history</summary><ul>{item.review_history.map((row, i) => <li key={i}><strong>{({ approve: 'Approved', correct: 'Corrected', reject: 'Rejected' } as Record<string, string>)[row.decision] || row.decision}</strong><p>{row.reason}</p></li>)}</ul></details>}
  </article>;
}

const comparisonRows: Record<string, number> = { base_rent_per_sf: 9, term_months: 13, free_rent_months: 14, landlord_ti_per_sf: 15 };
function Comparison({ client, entityRef, terms, isDisposed }: Options & { isDisposed: () => boolean }) {
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState('Prepare terms comparison');
  const [result, setResult] = useState<ReactNode>(null);
  const pending = useRef<ComparisonRequest | null>(null);
  const snapshot = useRef<Item[]>([]);
  function fieldLink(key: string) {
    return <a href={`#term-${key}`} data-comparison-field={key} onClick={event => {
      event.preventDefault(); event.stopPropagation();
      const target = document.getElementById(`term-${key}`); target?.scrollIntoView?.({ block: 'start' }); target?.focus({ preventScroll: true });
    }}>{terms[key]?.label || key}</a>;
  }
  async function prepare() {
    if (loading) return;
    setLoading(true); setResult(<p role="status">Preparing terms comparison…</p>);
    try {
      if (!pending.current) {
        const items: Item[] = []; let cursor: string | undefined;
        do {
          const page = await client.listFactReview({ entity_ref: entityRef, include_resolved: true, limit: 100, ...(cursor ? { cursor } : {}) });
          if (isDisposed()) return;
          if (page.schema_version !== 'fact-review.v1' || !Array.isArray(page.items) || page.items.some(item => item.entity_ref !== entityRef) || (page.has_more && (!page.next_cursor || page.next_cursor === cursor))) throw new Error('Terms unavailable');
          items.push(...page.items); cursor = page.has_more ? page.next_cursor || undefined : undefined;
        } while (cursor);
        snapshot.current = items;
        const fields = items.filter(item => Object.hasOwn(comparisonRows, item.fact_key) && item.canonical_version > 0 && item.canonical_history?.some(fact => fact.version < item.canonical_version))
          .sort((a, b) => comparisonRows[a.fact_key]! - comparisonRows[b.fact_key]!)
          .map(item => ({ fact_key: item.fact_key, prior_version: Math.max(...item.canonical_history.filter(f => f.version < item.canonical_version).map(f => f.version)), current_version: item.canonical_version }));
        if (!fields.length) { setResult(<><p>Confirm prior and current versions before preparing the comparison.</p><ul>{Object.keys(comparisonRows).map(key => <li key={key}>{fieldLink(key)} · Missing confirmed prior or current version.</li>)}</ul></>); return; }
        pending.current = { idempotency_key: crypto.randomUUID(), deal_id: entityRef, fields };
      }
      if (isDisposed()) return;
      const request = pending.current;
      const plan = await client.prepareTermsComparison(request);
      const edits = new Map(plan.edits.map(edit => [edit.where, edit.text]));
      const cell = (address: string) => edits.get(`cell:LOI Grid!${address}`);
      const version = (key: string, n: number) => { const fact = snapshot.current.find(item => item.fact_key === key)?.canonical_history.find(f => f.version === n); return `v${n}${fact?.promoted_at && Number.isFinite(Date.parse(fact.promoted_at)) ? ` · ${new Date(fact.promoted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}` : ''}`; };
      setResult(<article className="terms-draft" data-comparison-draft aria-label="Terms comparison draft"><header><h3>{plan.template.name}</h3><span className="fact-state">Draft</span></header><p className="terms-draft-note">{plan.human_gate}</p>
        {request.fields.map(ref => <p key={ref.fact_key} className="terms-versions"><strong>{terms[ref.fact_key]?.label}</strong> · Prior: {version(ref.fact_key, ref.prior_version)} · Current: {version(ref.fact_key, ref.current_version)}</p>)}
        <div className="terms-draft-groups">{[['B', 'Prior'], ['C', 'Current']].map(([column, title]) => <section key={column}><h4>{title}</h4><dl>{request.fields.map(ref => <div key={ref.fact_key}><dt>{cell(`A${comparisonRows[ref.fact_key]}`)}</dt><dd><strong>{cell(`${column}${comparisonRows[ref.fact_key]}`)}</strong><small>{cell(`${column}4`)?.replace(`${title} - `, '')}</small></dd></div>)}</dl></section>)}</div>
        <h4>Remaining work</h4><ul>{plan.remaining.map((text, i) => <li key={i}>{text}</li>)}{Object.keys(comparisonRows).filter(key => !request.fields.some(ref => ref.fact_key === key)).map(key => <li key={key}>{fieldLink(key)} · Missing confirmed versions for comparison.</li>)}</ul></article>);
      pending.current = null; setLabel('Prepare again');
    } catch (caught) {
      const error = caught as Error & { status?: number; payload?: { error?: string; reason?: string; field?: string }; pendingRequest?: ComparisonRequest };
      const payload = error.payload;
      if (payload?.reason === 'stale_snapshot' || payload?.error === 'stale_snapshot') { pending.current = null; setResult(<p>A fact changed since this snapshot. Prepare again to compare the latest confirmed versions.</p>); }
      else if (payload?.error === 'comparison_fact_blocked' && payload.field && Object.hasOwn(comparisonRows, payload.field)) {
        pending.current = null; const reason = ({ missing: 'Missing confirmed fact', unresolved: 'Unresolved fact', missing_version: 'Missing confirmed version', source_not_permitted: 'Source not permitted', invalid_value: 'Value needs review' } as Record<string, string>)[payload.reason || ''] || 'Fact needs review';
        setResult(<><p>Review the named field before preparing the comparison.</p><ul><li>{fieldLink(payload.field)} · {reason}.</li></ul></>);
      } else {
        const unavailable = !client.prepareTermsComparison || [404, 405, 501, 503].includes(error.status || 0) || payload?.error === 'comparison_template_unavailable';
        pending.current = error.pendingRequest || null;
        setResult(<p>{unavailable ? 'Terms comparison unavailable. The server or reviewed template may not be deployed yet.' : error.status === 401 || error.status === 403 ? 'Sign in again before preparing a terms comparison.' : 'Could not prepare the terms comparison.'}{pending.current ? ' Keep this tab open. Check outcome retries the same request.' : ' Try again.'}</p>);
      }
      setLabel(pending.current ? 'Check outcome' : 'Prepare again');
    } finally { setLoading(false); }
  }
  return <div data-terms-comparison><button type="button" className="btn" data-prepare-comparison disabled={loading} onClick={() => void prepare()}>{label}</button><div data-comparison-result aria-live="polite">{result}</div></div>;
}

function control(form: HTMLFormElement, name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement { return form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement; }
export function mountFactReview(root: HTMLElement, { client, entityRef, terms: FACT_TERMS }: Options) {
  let disposed = false, generation = 0, items: Item[] = [], writing = false, dirty = false;
  let documents: Document[] = [];
  let documentsAvailable = false;
  const pending = new Map<HTMLFormElement, { method: "recordHumanFact" | "resolveFactReview"; args: Args }>();
  const reactRoot = createRoot(root);
  let listContent: ReactNode = null;
  let recordRevision = 0;
  let documentSignature: string | undefined;
  function render() {
    flushSync(() => reactRoot.render(<><h2>Terms</h2><Comparison client={client} entityRef={entityRef} terms={FACT_TERMS} isDisposed={() => disposed} /><p role="status" data-terms-status>Loading terms…</p><div data-terms-list>{listContent}</div><div data-terms-record>{documents.length ? <details><summary>Record a term</summary><form data-fact-record><Entry key={recordRevision} documents={documents} prefix="record-term" terms={FACT_TERMS} /><button className="btn" type="submit">Record term</button><p role="status" data-write-status /></form></details> : <p>{documentsAvailable ? 'No stored documents for this deal.' : 'Stored documents unavailable. Recording and corrections are unavailable.'}</p>}</div><button type="button" className="btn" data-refresh-terms>Refresh terms</button></>));
  }
  function setDocuments(result: Document[] | null) {
    const next = result || [];
    const signature = JSON.stringify(result);
    documentsAvailable = result !== null;
    if (documentSignature === signature) return;
    documents = next;
    documentSignature = signature;
    render();
  }
  setDocuments(null);
  async function documentLoad() {
    try {
      const loaded: Document[] = []; let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await client.listDealDocuments({ deal_id: entityRef, limit: 100, ...(cursor ? { cursor } : {}) });
        if (page.ok !== true || page.schema_version !== 'deal-documents.v1' || !Array.isArray(page.documents)
          || page.documents.some(doc => !doc.id || !doc.display_name || typeof doc.stored_at !== 'string')
          || typeof page.has_more !== 'boolean') throw new Error('Documents unavailable');
        loaded.push(...page.documents);
        if (!page.has_more) return loaded;
        if (!page.next_cursor || page.next_cursor === cursor) throw new Error('Documents unavailable');
        cursor = page.next_cursor;
      }
    } catch { /* The server may not yet provide document metadata. */ }
    return null;
  }
  const status = root.querySelector<HTMLElement>('[data-terms-status]')!;
  const list = root.querySelector<HTMLElement>('[data-terms-list]')!;
  async function refresh(message = '') {
    if (disposed || writing || pending.size || dirty) return;
    const current = ++generation;
    status.textContent = 'Loading terms…';
    try {
      const loaded: Item[] = []; let cursor: string | null | undefined;
      const listedDocuments = await documentLoad();
      if (disposed || current !== generation || writing || pending.size || dirty) return;
      setDocuments(listedDocuments);
      do {
        const page = await client.listFactReview({ entity_ref: entityRef, include_resolved: true, limit: 100, ...(cursor ? { cursor } : {}) });
        if (disposed || current !== generation || writing || pending.size || dirty) return;
        if (page.schema_version !== 'fact-review.v1' || !Array.isArray(page.items) || page.items.some(item => item.entity_ref !== entityRef)) throw new Error('Terms unavailable');
        loaded.push(...page.items);
        if (page.has_more && (!page.next_cursor || page.next_cursor === cursor)) throw new Error('Terms unavailable');
        cursor = page.has_more ? page.next_cursor : null;
      } while (cursor);
      items = loaded;
      listContent = items.length ? items.map((item, index) => <Review key={`${generation}-${item.fact_key}`} item={item} index={index} documents={documents} terms={FACT_TERMS} />) : <p>No sourced terms recorded.</p>;
      listContent = <>{listContent}{Object.keys(comparisonRows).filter(key => !items.some(item => item.fact_key === key)).map(key => <section key={key} className="fact-term fact-empty" id={`term-${key}`} tabIndex={-1}><h3>{FACT_TERMS[key]?.label}</h3><p>No sourced terms recorded.</p></section>)}</>;
      render();
      status.textContent = message;
    } catch {
      if (!disposed && current === generation) {
        status.textContent = 'Terms unavailable. Refresh terms to try again.';
      }
    }
  }
  function markDirty() { dirty = true; }
  function change(event: { target: Controls }) {
    const form = event.target.closest('form');
    if (!form) return;
    if (event.target.name === 'decision') {
      const correcting = event.target.value === 'correct';
      form.querySelector<HTMLFieldSetElement>('[data-correction]')!.hidden = !correcting;
      form.querySelector<HTMLFieldSetElement>('[data-correction]')!.disabled = !correcting;
      form.querySelector<HTMLLabelElement>('[data-choose-value]')!.hidden = event.target.value !== 'approve';
      control(form, "observation_id").disabled = event.target.value !== 'approve';
    }
  }

  function humanFact(form: HTMLFormElement, factKey?: string): HumanFact {
    const data = new FormData(form);
    const key = factKey || String(data.get('fact_key'));
    const source = { document_ref: String(data.get('document_ref')), page_start: Number(data.get('page_start')), page_end: Number(data.get('page_end')), cited_text: String(data.get('cited_text')).trim() };
    if (!documents.some(doc => doc.id === source.document_ref)) throw new Error('Choose a stored document of this deal.');
    if (source.page_end < source.page_start) throw new Error('Last page must follow the first page.');
    if (!source.cited_text) throw new Error('Enter the cited text.');
    return { fact_key: key, value: String(data.get('value')).trim(), unit: String(data.get('unit')),
      ...(key === 'base_rent_per_sf' ? { expense_basis: String(data.get('expense_basis')) } : {}), source };
  }
  async function submit(event: Event) {
    const form = event.target as HTMLFormElement;
    if (!form.matches('[data-fact-review], [data-fact-record]')) return;
    event.preventDefault();
    if (writing) return;
    const output = form.querySelector<HTMLElement>('[data-write-status]')!;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    let request = pending.get(form);
    try {
      if (!request) {
        if (!form.reportValidity()) return;
        const args = { idempotency_key: crypto.randomUUID(), entity_ref: entityRef };
        if (form.matches('[data-fact-record]')) request = { method: 'recordHumanFact', args: { ...args, observation: humanFact(form) } };
        else {
          const item = items[Number(form.dataset.factReview)]!, data = new FormData(form);
          const decision = String(data.get('decision')), reason = String(data.get('reason')).trim();
          if (!reason) throw new Error('Enter a reason for this review.');
          request = { method: 'resolveFactReview', args: { ...args, fact_key: item.fact_key, base_version: item.canonical_version, review_version: item.review_version,
            decision, reason, ...(decision === 'approve' ? { observation_id: String(data.get('observation_id')) } : {}),
            ...(decision === 'correct' ? { correction: humanFact(form, item.fact_key) } : {}) } };
        }
        pending.set(form, request);
      }
      writing = true; generation++;
      for (const control of root.querySelectorAll<Controls>('input, select, textarea, button')) control.disabled = true;
      output.textContent = 'Saving…';
      const result = await client[request.method](request.args);
      if (result.ok !== true || result.schema_version !== 'fact-review.v1') throw new Error('Receipt unavailable');
      pending.delete(form);
      dirty = false;
      if (form.matches('[data-fact-record]')) { form.reset(); output.textContent = ''; recordRevision++; render(); }
      writing = false;
      await refresh(request.method === 'recordHumanFact' ? 'Term recorded for review.' : 'Review saved.');
    } catch (caught) {
      const error = caught as Error & { payload?: { error?: string }; status?: number; pendingRequest?: Args };
      if (disposed) return;
      writing = false;
      if (error.payload?.error === 'version_conflict') {
        const factKey = items[Number(form.dataset.factReview)]?.fact_key;
        const reason = control(form, 'reason')?.value;
        pending.delete(form);
        dirty = false;
        await refresh('Terms changed since you opened this review. Refreshed terms; review them again.');
        const refreshed = [...list.querySelectorAll<HTMLElement>('[data-fact-key]')].find(term => term.dataset.factKey === factKey);
        if (refreshed && reason) {
          refreshed.querySelector<HTMLTextAreaElement>('[name=reason]')!.value = reason;
          refreshed.querySelector<HTMLFormElement>('[data-fact-review]')!.hidden = false;
          refreshed.querySelector<HTMLButtonElement>('[data-review-term]')!.hidden = true;
          dirty = true;
        }
      } else if (error.payload?.error && !['internal_error', 'offline', 'DEPENDENCY_UNAVAILABLE'].includes(error.payload.error) && !error.pendingRequest || (error.status === 401 || error.status === 403) && !error.pendingRequest) {
        pending.delete(form);
        output.textContent = error.status === 401 || error.status === 403 ? 'Sign in again before reviewing terms.' : 'Term not saved. Check the value, source and reason, then try again.';
      } else if (pending.has(form)) {
        if (error.pendingRequest && request) request.args = error.pendingRequest;
        output.textContent = 'Save not confirmed. Keep this tab open. Check outcome retries the same request.';
        button.textContent = 'Check outcome';
      } else output.textContent = error.message;
    } finally {
      writing = false;
      if (!disposed) {
        for (const control of root.querySelectorAll<Controls>('input, select, textarea, button')) control.disabled = false;
        root.querySelector<HTMLButtonElement>('[data-refresh-terms]')!.disabled = pending.size > 0;
        for (const form of root.querySelectorAll<HTMLFormElement>('[data-fact-review]')) change({ target: control(form, "decision") });
        for (const form of root.querySelectorAll('form')) {
          if (control(form, "fact_key")) change({ target: control(form, "fact_key") });
          if (pending.has(form)) for (const control of form.querySelectorAll<Controls>('input, select, textarea')) control.disabled = true;
        }
      }
    }
  }
  function click(event: Event) {
    const target = event.target as HTMLElement;
    if (target.closest('[data-refresh-terms]')) void refresh();
    const button = target.closest<HTMLElement>('[data-review-term]');
    if (button) { button.hidden = true; (button.nextElementSibling as HTMLElement).hidden = false; }
  }
  root.addEventListener('submit', submit);
  const onChange = (event: Event) => change({ target: event.target as Controls });
  root.addEventListener('change', onChange);
  root.addEventListener('change', markDirty);
  root.addEventListener('input', markDirty);
  root.addEventListener('click', click);
  void refresh();
  return { refresh, dispose() {
    disposed = true; generation++;
    reactRoot.unmount();
    root.removeEventListener('submit', submit); root.removeEventListener('change', onChange); root.removeEventListener('click', click);
    root.removeEventListener('change', markDirty); root.removeEventListener('input', markDirty);
  } };
}
