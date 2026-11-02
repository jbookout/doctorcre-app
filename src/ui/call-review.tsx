import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
type Payload = {
  summary?: string | null; text?: string | null; next_date?: string | null; value?: string | null;
  body?: string | null; assignee?: string | null; due_on?: string | null;
  started_on?: string | null; action?: string | null; subject?: string | null;
  base_event_id?: string | null; plan_base?: Record<string, string | null>;
};
type Candidate = { resolver: string | null; candidate_id: string; kind: string; deal_id: string | null; deal_name: string | null; payload: Payload; evidence_quote: string | null };
type Change = Candidate & { deal_version: number; undone_at: string | null };
type Call = { session_id: string; call_date: string; applied: Change[]; open_cards: Candidate[] };
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function object(value: unknown) { if (!isObject(value)) throw new Error('Call data unavailable'); return value; }
function text(value: unknown) { if (typeof value !== 'string') throw new Error('Call text unavailable'); return value; }
function optionalText(value: unknown) { return value == null ? null : text(value); }
function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('Call items unavailable'); return value; }
function candidate(value: unknown): Candidate {
  const row = object(value), raw = row.payload === undefined ? {} : object(row.payload), payload: Payload = {};
  for (const key of ['summary', 'text', 'next_date', 'value', 'started_on', 'action', 'subject', 'base_event_id', 'body', 'assignee', 'due_on'] as const) {
    if (Object.hasOwn(raw, key)) payload[key] = optionalText(raw[key]);
  }
  if (raw.plan_base !== undefined) payload.plan_base = Object.fromEntries(Object.entries(object(raw.plan_base)).map(([field, value]) => [field, optionalText(value)]));
  return { resolver: optionalText(row.resolver), candidate_id: text(row.candidate_id), kind: text(row.kind), deal_id: optionalText(row.deal_id),
    deal_name: optionalText(row.deal_name), evidence_quote: optionalText(row.evidence_quote), payload };
}
function callAnswer(value: unknown): { calls: Call[] } {
  return { calls: list(object(value).calls).map(value => {
    const row = object(value);
    return { session_id: text(row.session_id), call_date: text(row.call_date), open_cards: list(row.open_cards).map(candidate),
      applied: list(row.applied).map(value => {
        const row = object(value);
        if (typeof row.deal_version !== 'number' || !Number.isFinite(row.deal_version)) throw new Error('Deal version unavailable');
        return { ...candidate(value), deal_version: row.deal_version, undone_at: optionalText(row.undone_at) };
      }) };
  }) };
}
function appliedSignature(change: Change) { return JSON.stringify({ ...change, deal_version: undefined }); }
function receipt(value: unknown) { if (object(value).ok !== true) throw new Error('Command refused'); }
type Item = { call: Call; key: string; signature: string; before: string } & (
  { state: 'applied'; candidate: Change } | { state: 'pending' | 'resolved'; candidate: Candidate }
);
type Client = {
  readCallOutcomes(): Promise<unknown>;
  getDeal?(id: string): Promise<unknown>;
  undoCallChange(args: { candidate_id: string; base_version: number }): Promise<unknown>;
  resolvePostCallCandidate?(args: { candidate_id: string; accept: boolean; idempotency_key: string }): Promise<unknown>;
  resolveConfirm?(args: { proposal_id: string; accept: boolean; idempotency_key: string }): Promise<unknown>;
  reviewCallOutcome(args: { session_id: string }): Promise<unknown>;
};
type Options = {
  client(): Client;
  describe(change: Candidate): string;
  dateLabel?(value: string): string;
  undoRefusal(error: unknown): string;
  onChange?(state: { completed: boolean }): void;
} & ({ sessionId: string; filter?: never } | { filter(): string[]; sessionId?: never });
type Load = { state: 'loading' | 'ready' | 'empty' | 'signed_out' | 'completed' } | { state: 'unavailable'; message: string };
function beforeText(candidate: Candidate, detail: unknown) {
  if (!['phase_move', 'next_step'].includes(candidate.kind)) return 'Not yet added by this proposal.';
  const field = candidate.kind === 'phase_move' ? 'phase' : 'next_step';
  const base: Record<string, string | null | undefined> | undefined = candidate.kind === 'phase_move' && Object.hasOwn(candidate.payload, 'base_event_id') ? { phase: candidate.payload.base_event_id } : candidate.payload.plan_base;
  if (!base || !Object.hasOwn(base, field)) return 'Earlier value unavailable.';
  if (base[field] === null) return 'No earlier value recorded.';
  const history: unknown[] = isObject(detail) && Array.isArray(detail.history) ? detail.history : [];
  const event = history.find(row => isObject(row) && row.id === base[field]);
  return isObject(event) && typeof event.new_value === 'string' ? event.new_value : 'Earlier value unavailable.';
}
function signedOut(error: unknown) { return isObject(error) && (error.status === 401 || error.status === 403); }

export function mountCallReview(container: HTMLElement, options: Options) {
  const root = createRoot(container);
  let disposed = false, revoked = false, sequence = 0, writing = false;
  let load: Load = { state: 'loading' }, items: Item[] = [], selected: string | undefined, notice = '';
  let deciding: string | undefined;
  const completed = () => load.state === 'completed';
  const reviewed = new Map<string, string>();
  const complete = (item: Item) => item.state === 'resolved' || reviewed.get(item.key) === item.signature;
  const outstanding = () => items.find(item => !complete(item));
  const current = () => items.find(item => item.key === selected) ?? outstanding() ?? items[0];
  const clear = () => { items = []; reviewed.clear(); selected = undefined; };
  function render() {
    if (disposed) return;
    container.hidden = false;
    flushSync(() => root.render(<Guide />));
  }
  async function refresh({ preserveSelection = true } = {}) {
    if (disposed || revoked || writing || load.state === 'completed') return;
    const read = ++sequence;
    if (!items.length) { load = { state: 'loading' }; render(); }
    try {
      const answer = callAnswer(await options.client().readCallOutcomes());
      const ids = new Set(options.filter?.());
      const calls = answer.calls.filter(call => options.sessionId !== undefined
        ? call.session_id === options.sessionId
        : [...call.applied, ...call.open_cards].some(item => ids.has(item.candidate_id)));
      const deals = [...new Set(calls.flatMap(call => [...call.applied, ...call.open_cards].flatMap(item => item.deal_id ? [item.deal_id] : [])))];
      const details = new Map(await Promise.all(deals.map(async id => {
        try { return [id, await options.client().getDeal?.(id)] as const; }
        catch (error) { if (signedOut(error)) throw error; return [id, null] as const; }
      })));
      if (disposed || revoked || read !== sequence) return;
      const previous = items;
      items = calls.flatMap(call => {
        const applied: Item[] = call.applied.map(candidate => ({ call, candidate, state: 'applied',
          key: `${call.session_id}:${candidate.candidate_id}`, signature: appliedSignature(candidate), before: beforeText(candidate, details.get(candidate.deal_id ?? '')) }));
        const pending: Item[] = call.open_cards.map(candidate => ({ call, candidate, state: 'pending',
          key: `${call.session_id}:${candidate.candidate_id}`, signature: JSON.stringify(candidate), before: beforeText(candidate, details.get(candidate.deal_id ?? '')) }));
        const resolved: Item[] = previous.filter(item => item.call.session_id === call.session_id && item.state !== 'applied'
          && ![...applied, ...pending].some(next => next.key === item.key)).map(item => ({ ...item, state: 'resolved' }));
        const dealOrder = new Map<string, number>();
        for (const candidate of [...call.applied, ...call.open_cards, ...resolved.map(item => item.candidate)]) {
          const deal = candidate.deal_id ?? '';
          if (!dealOrder.has(deal)) dealOrder.set(deal, dealOrder.size);
        }
        return [...applied, ...pending, ...resolved].sort((a, b) => (dealOrder.get(a.candidate.deal_id ?? '') ?? 0) - (dealOrder.get(b.candidate.deal_id ?? '') ?? 0));
      });
      if (!preserveSelection || !items.some(item => item.key === selected)) selected = outstanding()?.key ?? items[0]?.key;
      load = { state: items.length ? 'ready' : 'empty' };
    } catch (error) {
      if (disposed || revoked || read !== sequence) return;
      if (signedOut(error)) { clear(); load = { state: 'signed_out' }; }
      else load = { state: 'unavailable', message: 'Could not check this call. Refresh before continuing the review.' };
    }
    render();
  }
  async function act(run: () => Promise<unknown>, refused: (error: unknown) => string) {
    if (disposed || revoked || writing || load.state !== 'ready') return;
    writing = true; notice = ''; render();
    try {
      const result = await run();
      if (isObject(result) && result.ok === false) throw new Error('Command refused');
      if (disposed || revoked) return;
      writing = false;
      if (!completed()) await refresh({ preserveSelection: true });
      if (!disposed && !revoked) options.onChange?.({ completed: completed() });
    } catch (error) {
      if (disposed) return;
      if (signedOut(error)) { clear(); load = { state: 'signed_out' }; }
      else {
        notice = refused(error);
        writing = false;
        await refresh({ preserveSelection: true });
      }
    } finally { writing = false; render(); }
  }
  async function completeCall() {
    const latest = callAnswer(await options.client().readCallOutcomes());
    const sessions = new Set(items.map(row => row.call.session_id));
    latest.calls.filter(call => sessions.has(call.session_id)).forEach(call => {
      if (call.open_cards.length || call.applied.some(candidate => reviewed.get(`${call.session_id}:${candidate.candidate_id}`) !== appliedSignature(candidate))) throw new Error('Call changed');
    });
    if (disposed || revoked) return;
    await Promise.all([...sessions].map(async session_id => receipt(await options.client().reviewCallOutcome({ session_id }))));
    if (disposed || revoked) return;
    clear(); load = { state: 'completed' };
  }
  async function decide(item: Item, accept: boolean) {
    const client = options.client(), idempotency_key = crypto.randomUUID();
    if (item.candidate.resolver === 'resolve-post-call-candidate' && client.resolvePostCallCandidate) {
      const result = await client.resolvePostCallCandidate({ candidate_id: item.candidate.candidate_id, accept, idempotency_key });
      if (isObject(result) && result.ok === false) throw new Error('Decision refused');
    } else if (item.candidate.resolver === 'resolve-candidate' && client.resolveConfirm) {
      const result = await client.resolveConfirm({ proposal_id: item.candidate.candidate_id, accept, idempotency_key });
      if (isObject(result) && result.ok === false) throw new Error('Decision refused');
    } else throw new Error('Decision unavailable');
    deciding = undefined;
  }
  function proposalText(candidate: Candidate) {
    if (candidate.kind === 'next_step' || candidate.kind === 'phase_move') return options.describe(candidate);
    return candidate.payload.action || candidate.payload.subject || candidate.payload.summary || candidate.payload.text || 'Open the decision card for the full proposal.';
  }
  function Guide() {
    const item = current(), index = item ? items.indexOf(item) : 0;
    const ready = load.state === 'ready' && !writing;
    const deals = [...new Set(items.flatMap(row => row.candidate.deal_id ? [row.candidate.deal_id] : []))];
    const done = items.filter(complete).length;
    return <section className="call-review" aria-label="Review this call" data-review-candidate={item?.candidate.candidate_id}>
      <link rel="stylesheet" href="/css/call-review.css" />
      <h2>Review this call</h2>
      {load.state === 'loading' && <p role="status">Loading call review…</p>}
      {load.state === 'completed' && <p role="status">Call review complete.</p>}
      {load.state === 'empty' && <p role="status">No call items to review.</p>}
      {load.state === 'signed_out' && <p role="status">Sign in again to review this call.</p>}
      {load.state === 'unavailable' && <p role="alert">{load.message}</p>}
      {notice && <p role="alert">{notice}</p>}
      {load.state === 'ready' && item && <>
        <p className="call-review-meta">{options.dateLabel?.(item.call.call_date) ?? item.call.call_date} · Item {index + 1} of {items.length}</p>
        <p className="call-review-progress-label">{done} of {items.length} reviewed</p>
        <progress aria-label="Call review progress" value={done} max={items.length} />
        <p className="call-review-deal-position">{item.candidate.deal_id ? `Deal ${deals.indexOf(item.candidate.deal_id) + 1} of ${deals.length}` : 'No deal linked'}</p>
        <h3>{item.candidate.deal_name || (item.candidate.deal_id ? 'Deal' : 'No deal')}</h3>
        <p className="call-review-meta">{item.state === 'pending' ? 'Needs your decision' : item.state === 'resolved' ? 'No longer pending' : item.state === 'applied' && item.candidate.undone_at ? 'Undone' : 'Already applied'}</p>
        <dl><div><dt>Before</dt><dd>{item.before}</dd></div><div><dt>{item.state === 'pending' ? 'Proposed' : 'From this call'}</dt><dd>{proposalText(item.candidate)}</dd></div></dl>
        <blockquote aria-label="What was said">{item.candidate.evidence_quote || 'No transcript quote included. Check the full report below.'}</blockquote>
        <div className="call-review-actions">
          {item.state === 'applied' && <button type="button" className="primary" disabled={!ready || complete(item)} onClick={() => { reviewed.set(item.key, item.signature); selected = outstanding()?.key ?? item.key; notice = ''; render(); }}>Reviewed</button>}
          {item.state === 'applied' && !item.candidate.undone_at && <button type="button" className="secondary" data-call-undo={item.candidate.candidate_id} disabled={!ready} onClick={() => void act(() => options.client().undoCallChange({ candidate_id: item.candidate.candidate_id, base_version: item.candidate.deal_version }), options.undoRefusal)}>Undo</button>}
          {item.state === 'pending' && <button type="button" className={deciding === item.key ? "secondary" : "primary"} disabled={!ready} onClick={() => { deciding = item.key; render(); }}>Approve or fix this item</button>}
          {item.candidate.deal_id && <a className="call-outcome-link" href={`/deals?deal=${encodeURIComponent(item.candidate.deal_id)}`}>Open deal to fix</a>}
        </div>
        {item.state === 'pending' && deciding === item.key && <section className="call-review-decision" aria-label="Decide this item">
          <h4>Decide this item</h4>
          {item.candidate.payload.body && <p style={{ whiteSpace: 'pre-wrap' }}>{item.candidate.payload.body}</p>}
          {item.candidate.payload.assignee && <p>Assigned to {(item.candidate.payload.assignee === 'joe' ? 'Joe' : item.candidate.payload.assignee === 'dell' ? 'Dell' : item.candidate.payload.assignee)} · {item.candidate.payload.due_on ? (options.dateLabel?.(item.candidate.payload.due_on) ?? item.candidate.payload.due_on) : 'No due date'}</p>}
          <p>Check the proposal and quote above. Approve it, or skip it and make any correction on the deal.</p>
          <div className="call-review-actions">
            <button type="button" className="primary" disabled={!ready} onClick={() => void act(() => decide(item, true), () => 'Could not approve this item. Refresh and check before retrying.')}>Approve item</button>
            <button type="button" className="secondary" disabled={!ready} onClick={() => void act(() => decide(item, false), () => 'Could not skip this item. Refresh and check before retrying.')}>Skip item</button>
          </div>
          <p className="call-review-meta">Email proposals create drafts only.</p>
        </section>}
        {item.state === 'pending' && <p className="call-review-meta">This item stays outstanding until its decision is recorded.</p>}
        <nav aria-label="Call review navigation">
          <button type="button" className="secondary" disabled={!ready || index === 0} onClick={() => { deciding = undefined; selected = items[Math.max(index - 1, 0)]?.key; notice = ''; render(); }}>Back</button>
          <button type="button" className="secondary" disabled={!ready || index === items.length - 1} onClick={() => { deciding = undefined; selected = items[Math.min(index + 1, items.length - 1)]?.key; notice = ''; render(); }}>Next</button>
          <button type="button" className="primary" disabled={!ready || items.some(row => row.state === 'pending' || !complete(row))} onClick={() => void act(completeCall, () => 'Could not complete this call review. Refresh and check outstanding items before retrying.')}>Complete call review</button>
        </nav>
        <p className="call-review-meta">Check each item before completing the call review.</p>
      </>}
      {load.state === 'completed' ? <a href="/">Back to Home</a> : <button type="button" className="secondary" disabled={writing || load.state === 'loading' || load.state === 'signed_out'} onClick={() => void refresh()}>Refresh call review</button>}
    </section>;
  }
  render();
  const invalidate = () => { revoked = true; sequence++; clear(); load = { state: 'signed_out' }; render(); };
  container.ownerDocument.defaultView?.addEventListener('doctorcre-session-invalidated', invalidate);
  return { refresh, dispose() {
    disposed = true; sequence++; clear();
    container.ownerDocument.defaultView?.removeEventListener('doctorcre-session-invalidated', invalidate);
    root.unmount(); container.hidden = true;
  } };
}

export function mountCallReviewDialog(document: Document, options: Omit<Options, 'sessionId' | 'filter'>) {
  const dialog = document.createElement('dialog');
  dialog.className = 'call-review-dialog';
  dialog.setAttribute('aria-label', 'Filed call review');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'call-review-close';
  close.textContent = 'Close call review';
  close.addEventListener('click', () => dialog.close());
  const node = document.createElement('div');
  const toolbar = document.createElement('header');
  toolbar.className = 'call-review-toolbar';
  const docSlot = document.createElement('div');
  docSlot.setAttribute('data-doc-presence-slot', '');
  toolbar.append(docSlot, close);
  dialog.append(toolbar, node);
  document.body.append(dialog);
  let guide: ReturnType<typeof mountCallReview> | undefined, session: string | undefined, disposed = false;
  return {
    async open(sessionId: string) {
      if (disposed) return;
      if (session !== sessionId) {
        guide?.dispose();
        session = sessionId;
        guide = mountCallReview(node, { ...options, sessionId });
      }
      if (!dialog.open) dialog.showModal();
      await guide?.refresh();
    },
    dispose() { disposed = true; guide?.dispose(); dialog.remove(); },
  };
}
