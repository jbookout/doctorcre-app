import { useEffect, useRef, useState } from 'react';
import type { InboxClient, InboxItem, TaskReceipt } from './inbox';
import { reviewError, type Operation, type Review, type ReviewRequest } from './review';

type State = { phase: 'loading' } | { phase: 'ready' | 'editing'; review: Review } | { phase: 'submitting' | 'uncertain'; review: Review; request: ReviewRequest } | { phase: 'conflict'; review: Review; message: string } | { phase: 'refused' | 'done'; message: string };
const labels: Record<Operation['verb'], string> = { 'complete-one-action': 'Mark done', 'edit-email-draft': 'Save draft', 'dismiss-email-proposal': 'Decline draft', 'submit-email-draft': 'Submit reply for sending', 'resolve-fact-review': 'Save review' };
type Props = { item: InboxItem; client: NonNullable<InboxClient['review']>; close(): void; busy(value: boolean): void; confirmed(item: InboxItem, receipt?: TaskReceipt): void };
export function ReviewCard({ item, client, close, busy, confirmed }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState('approve');
  const [observation, setObservation] = useState('');
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const alive = useRef(true);
  const host = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const anchor = useRef(item);
  useEffect(() => {
    const controller = new AbortController(); alive.current = true;
    void client.load(anchor.current, controller.signal).then(review => {
      if (controller.signal.aborted) return;
      if (review.kind === 'reply_draft') { setSubject(review.subject); setBody(review.body); }
      if (review.kind === 'fact_review') { setDecision(review.observations.length ? 'approve' : 'reject'); setObservation(review.observations[0]?.id || ''); }
      setState({ phase: 'ready', review });
    }).catch(error => { if (!controller.signal.aborted) setState({ phase: 'refused', message: reviewError(error).kind === 'uncertain' ? 'Could not load this review. Close and try again.' : reviewError(error).message }); });
    host.current?.focus();
    return () => { alive.current = false; controller.abort(); };
  }, [client]);
  const waiting = state.phase === 'submitting' || lock.current;
  const review = 'review' in state ? state.review : null;
  const editable = state.phase === 'ready' || state.phase === 'editing';
  async function reload() {
    if (lock.current) return;
    lock.current = true; busy(true); setMessage('Loading the updated card. Your edits are kept.');
    try {
      const current = await client.current(anchor.current);
      const updated = await client.load(current);
      if (!alive.current) return;
      anchor.current = current;
      confirmed(current);
      setState({ phase: 'ready', review: updated });
      setMessage('Updated evidence loaded. Your edits are kept. Review the evidence and recipients before submitting again.');
    } catch (error) { if (alive.current) setMessage(reviewError(error).message); }
    finally { lock.current = false; busy(false); }
  }
  async function run(request: ReviewRequest, detail: Review) {
    if (lock.current) return;
    lock.current = true; busy(true); setState({ phase: 'submitting', review: detail, request }); setMessage('Waiting for server confirmation…');
    try {
      const result = await client.run(anchor.current, request);
      if (!alive.current) return;
      confirmed(result.item, result.receipt);
      if (request.verb === 'edit-email-draft') {
        anchor.current = result.item;
        const next = await client.load(result.item);
        if (!alive.current) return;
        if (next.kind !== 'reply_draft' || next.operations.some(op => op.args.base_version !== result.saved_version) || next.subject !== request.args.subject || next.body !== request.args.body) throw Object.assign(Error('The saved draft changed again.'), { payload: { error: 'version_conflict' } });
        setState({ phase: 'ready', review: next }); setMessage('Saved as a draft. Nothing was sent.');
      } else { setState({ phase: 'done', message: request.verb === 'submit-email-draft' ? 'Reply submitted to the existing sender. Delivery is not yet confirmed.' : 'This card is confirmed. Its current state is shown in your inbox.' }); setMessage(''); }
    } catch (error) {
      if (!alive.current) return;
      const failure = reviewError(error);
      setMessage('');
      if (failure.kind === 'uncertain') setState({ phase: 'uncertain', review: detail, request });
      else if (failure.kind === 'conflict') setState({ phase: 'conflict', review: detail, message: failure.message });
      else setState({ phase: 'refused', message: failure.message });
    } finally { lock.current = false; busy(false); }
  }
  function choose(op: Operation) {
    if (!review || !editable || lock.current || !form.current?.reportValidity()) return;
    let input: Record<string, unknown> = {};
    if (op.verb === 'edit-email-draft' || op.verb === 'submit-email-draft') input = { subject, body };
    if (op.verb === 'dismiss-email-proposal') {
      if (!reason.trim()) { setMessage('Give a reason before declining this draft.'); return; }
      input = { reason };
    }
    if (op.verb === 'resolve-fact-review') {
      if (!reason.trim()) { setMessage('Give a reason for this review.'); return; }
      input = { decision, reason, ...(decision === 'approve' ? { observation_id: observation } : {}) };
      if (decision === 'correct') {
        const data = new FormData(form.current);
        input.correction = { fact_key: op.args.fact_key, value: data.get('value'), unit: data.get('unit'), ...(op.args.fact_key === 'base_rent_per_sf' ? { expense_basis: data.get('expense_basis') } : {}), source: { document_ref: data.get('document_ref'), page_start: Number(data.get('page_start')), page_end: Number(data.get('page_end')), cited_text: data.get('cited_text') } };
      }
    }
    void run({ verb: op.verb, args: { ...op.args, ...input, idempotency_key: crypto.randomUUID() } }, review);
  }
  return <div className="home-inline-review" ref={host} tabIndex={-1} role="region" aria-label={`Review ${item.title}`} onKeyDown={event => { if (event.key === 'Escape' && !waiting && state.phase !== 'uncertain') { event.preventDefault(); close(); } }} onTouchStart={event => event.stopPropagation()} onTouchEnd={event => event.stopPropagation()}>
    <header><h4>Review this card</h4><button type="button" disabled={waiting || state.phase === 'uncertain'} onClick={close}>Close review</button></header>
    {state.phase === 'loading' && <p role="status">Loading current evidence…</p>}
    {(state.phase === 'refused' || state.phase === 'done') && <p role="status">{state.message}</p>}
    {review && <form ref={form} onSubmit={event => event.preventDefault()} onChange={() => { if (state.phase === 'ready') setState({ phase: 'editing', review }); setMessage(''); }}>
      <fieldset disabled={!editable}>
        <legend>{review.kind === 'reply_draft' ? 'Exact reply for review' : review.kind === 'fact_review' ? 'Evidence and decision' : 'Task'}</legend>
        {review.kind === 'action' && <p>{review.title}</p>}
        {review.kind === 'reply_draft' && <><p>To: {review.to.join(', ')}</p><p>CC: {review.cc.join(', ')}</p><details><summary>Current saved reply</summary><p>{review.subject}</p><p>{review.body}</p></details><label>Subject<input value={subject} onChange={event => setSubject(event.target.value)} maxLength={998} required /></label><label>Message<textarea aria-label="Message" value={body} onChange={event => setBody(event.target.value)} rows={8} maxLength={20000} required /></label><p>Save draft sends nothing. Submit reply authorizes the existing sender to send this exact content to these recipients.</p><label>Reason for declining<input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label></>}
        {review.kind === 'fact_review' && <><p>Canonical value: {review.canonical}</p>{review.observations.map(o => <section key={o.id}><strong>{o.value} {o.unit}</strong><p>Document {o.source.document_ref}, pages {o.source.page_start} to {o.source.page_end}</p><blockquote>{o.source.cited_text || 'Excerpt no longer available'}</blockquote></section>)}
          <label>Decision<select aria-label="Decision" value={decision} onChange={event => setDecision(event.target.value)}>{review.operations[0]?.decisions.map(d => <option key={d} value={d} disabled={d === 'approve' && !review.observations.length || d === 'correct' && (!review.observations.length || review.operations[0]?.args.fact_key === 'rent_schedule')}>{d === 'approve' ? 'Approve a sourced value' : d === 'correct' ? 'Correct with a source' : 'Reject this review'}</option>)}</select></label>
          {decision === 'approve' && <label>Choose a sourced value<select aria-label="Choose a sourced value" value={observation} onChange={event => setObservation(event.target.value)} required>{review.observations.map(o => <option key={o.id} value={o.id}>{o.value} {o.unit}, pages {o.source.page_start} to {o.source.page_end}</option>)}</select></label>}
          {decision === 'correct' && <><label>Corrected value<input name="value" inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,29})(?:[.][0-9]{1,18})?" required /></label><label>Unit<select aria-label="Unit" name="unit">{[...new Set(review.observations.map(o => o.unit))].map(unit => <option key={unit}>{unit}</option>)}</select></label>{review.operations[0]?.args.fact_key === 'base_rent_per_sf' && <label>Expense basis<select aria-label="Expense basis" name="expense_basis"><option value="nnn">NNN</option><option value="modified_gross">Modified gross</option><option value="full_service_gross">Full service gross</option><option value="gross">Gross</option></select></label>}<label>Source document<select aria-label="Source document" name="document_ref">{[...new Set(review.observations.map(o => o.source.document_ref))].map(id => <option key={id} value={id}>Document {id}</option>)}</select></label><label>First page<input name="page_start" type="number" min={1} max={100000} defaultValue={1} required /></label><label>Last page<input name="page_end" type="number" min={1} max={100000} defaultValue={1} required /></label><label>Cited text<textarea name="cited_text" maxLength={4000} required /></label></>}
          <label>Reason<textarea aria-label="Reason" value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} required /></label></>}
      </fieldset>
      <div className="inbox-actions">{review.operations.map(op => <button type="button" key={op.verb} disabled={!editable} onClick={() => choose(op)}>{labels[op.verb]}</button>)}</div>
    </form>}
    {state.phase === 'conflict' && <><p role="alert">{state.message}</p><button type="button" onClick={() => void reload()}>Review updated card</button></>}
    {state.phase === 'uncertain' && <><p role="alert">The result is uncertain. Your exact request is kept. Nothing retries automatically.</p><button type="button" onClick={() => void run(state.request, state.review)}>Retry same review request</button></>}
    {message && <p role="status">{message}</p>}
  </div>;
}
