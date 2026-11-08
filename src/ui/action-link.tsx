import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Request = (name: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>;
type LeadDraft = { kind: 'lead_draft'; id: string; revision: number; subject: string; body: string; scheduledFor: string | null; timeZone: string };
type ReplyDraft = { kind: 'reply_draft'; id: string; revision: number; subject: string; body: string; to: [string]; cc: [string] };
type Draft = LeadDraft | ReplyDraft;
type State = { kind: 'loading' } | { kind: 'ready'; card: Draft; key: string; phase: 'idle' | 'saving' | 'unknown' }
  | { kind: 'approved'; draftKind: Draft['kind'] } | { kind: 'unavailable'; message: string; retry: boolean } | { kind: 'signed-out' };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function isScheduledInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHour, offsetMinute] = parts;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const daysInMonth = days[month - 1];
  return daysInMonth !== undefined && day >= 1 && day <= daysInMonth
    && Number(hourText) < 24 && Number(minuteText) < 60 && Number(secondText) < 60
    && (offsetHour === undefined || Number(offsetHour) < 24 && Number(offsetMinute) < 60)
    && Number.isFinite(Date.parse(value));
}
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const address = (value: unknown): value is [string] => Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value[0]);
function parseReply(payload: Record<string, unknown>, ref: string): ReplyDraft | null {
  if (!exactKeys(payload, ['schema_version', 'ref', 'card']) || payload.ref !== ref || !object(payload.card)) return null;
  const c = payload.card;
  if (!exactKeys(c, ['kind', 'id', 'state', 'source_version', 'subject', 'body', 'to', 'cc', 'actions'])
    || c.kind !== 'reply_draft' || !uuid(c.id) || c.state !== 'pending_approval'
    || typeof c.source_version !== 'number' || !Number.isSafeInteger(c.source_version) || c.source_version < 1
    || typeof c.subject !== 'string' || typeof c.body !== 'string' || !address(c.to) || !address(c.cc)
    || !Array.isArray(c.actions) || c.actions.length !== 1) return null;
  const a: unknown = c.actions[0];
  if (!object(a) || !exactKeys(a, ['action', 'verb', 'args']) || a.action !== 'approve' || a.verb !== 'submit-email-draft' || !object(a.args)) return null;
  const args = a.args;
  if (!exactKeys(args, ['proposal_id', 'base_version', 'subject', 'body', 'to', 'cc']) || args.proposal_id !== c.id || args.base_version !== c.source_version
    || args.subject !== c.subject || args.body !== c.body || JSON.stringify(args.to) !== JSON.stringify(c.to) || JSON.stringify(args.cc) !== JSON.stringify(c.cc)) return null;
  try {
    const issued = atob(ref.slice(4).replace(/-/g, '+').replace(/_/g, '/'));
    if (issued !== `rd:${c.id}:joe:${c.source_version}` && issued !== `rd:${c.id}:dell:${c.source_version}`) return null;
  } catch { return null; }
  return { kind: 'reply_draft', id: c.id, revision: c.source_version, subject: c.subject, body: c.body, to: [c.to[0]], cc: [c.cc[0]] };
}
export function parseDraft(payload: unknown, ref: string): Draft | null {
  if (object(payload) && payload.schema_version === 'action-link-resolve.v2') return parseReply(payload, ref);
  if (!object(payload) || payload.schema_version !== 'action-link-resolve.v1' || payload.ref !== ref || !object(payload.card)) return null;
  const card = payload.card;
  if (card.kind !== 'lead_draft' || card.state !== 'pending_approval' || !uuid(card.id) || !uuid(card.lead_id)
    || typeof card.revision !== 'number' || !Number.isSafeInteger(card.revision) || card.revision < 1
    || typeof card.subject !== 'string' || typeof card.body !== 'string' || typeof card.time_zone !== 'string'
    || !(card.scheduled_for === null || isScheduledInstant(card.scheduled_for))
    || !Array.isArray(card.actions) || card.actions.length !== 1) return null;
  const action: unknown = card.actions[0];
  if (!object(action) || action.action !== 'approve' || action.verb !== 'approve-lead-draft' || !object(action.args)
    || action.args.draft_id !== card.id || action.args.revision !== card.revision) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: card.time_zone }); } catch { return null; }
  return { kind: 'lead_draft', id: card.id, revision: card.revision, subject: card.subject, body: card.body, scheduledFor: card.scheduled_for, timeZone: card.time_zone };
}
function refusal(code: unknown): State | null {
  // eslint-disable-next-line no-restricted-syntax -- Unavailable links only return retry=false metadata; they schedule no resolve requests.
  if (code === 'action_link_not_found') return { kind: 'unavailable', message: 'This draft is unavailable for your account.', retry: false };
  // eslint-disable-next-line no-restricted-syntax -- Nonactionable drafts only return retry=false metadata; they schedule no resolve or approval attempts.
  if (['action_link_no_longer_actionable', 'draft_not_pending', 'email_draft_not_pending', 'email_draft_not_found', 'email_draft_not_owner', 'email_draft_recipients_mismatch', 'key_reuse'].includes(String(code))) return { kind: 'unavailable', message: 'This draft is no longer awaiting approval.', retry: false };
  // eslint-disable-next-line no-restricted-syntax -- Only a manual reload can resolve the stale draft again; no automatic approval occurs.
  if (code === 'stale_draft_revision' || code === 'version_conflict') return { kind: 'unavailable', message: 'This draft changed. Reload it before approving.', retry: true };
  if (['not_authenticated', 'authentication_required', 'forbidden', 'permission_denied'].includes(String(code))) return { kind: 'signed-out' };
  return null;
}
function ActionLink({ ref, request }: { ref: string; request: Request }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    setState({ kind: 'loading' }); busy.current = false;
    const read = async () => {
      if (!/^al1_[A-Za-z0-9_-]{1,120}$/.test(ref)) {
        // eslint-disable-next-line no-restricted-syntax -- Invalid references only set retry=false state; they send no resolve requests.
        setState({ kind: 'unavailable', message: 'This draft link is invalid.', retry: false }); return;
      }
      try {
        const result = await request('resolve-action-link', { ref }, { signal: controller.signal, timeoutMs: 10_000 });
        if (controller.signal.aborted) return;
        if (object(result) && result.kind === 'authorization') { setState({ kind: 'signed-out' }); return; }
        if (object(result) && result.kind === 'payload') {
          const payload = result.payload;
          if (object(payload) && (result.isError || payload.error)) {
            // eslint-disable-next-line no-restricted-syntax -- Only a manual reload can retry a refused resolve result; no scheduled retry occurs.
            setState(refusal(payload.error) || { kind: 'unavailable', message: 'The draft could not be opened.', retry: true }); return;
          }
          const card = parseDraft(payload, ref);
          if (card) { setState({ kind: 'ready', card, key: crypto.randomUUID(), phase: 'idle' }); return; }
        }
        // eslint-disable-next-line no-restricted-syntax -- Only a manual reload can retry a malformed draft result; no scheduled resolve retry occurs.
        setState({ kind: 'unavailable', message: 'The draft could not be opened.', retry: true });
      // eslint-disable-next-line no-restricted-syntax -- Only a manual reload can retry a failed resolve; aborted requests do not update state.
      } catch { if (!controller.signal.aborted) setState({ kind: 'unavailable', message: 'The draft could not be opened.', retry: true }); }
    };
    void read();
    return () => controller.abort();
  }, [ref, request, reload]);
  const approve = async () => {
    if (state.kind !== 'ready' || busy.current || !lifetime.current || lifetime.current.signal.aborted) return;
    busy.current = true;
    const { card, key } = state, signal = lifetime.current.signal;
    setState({ ...state, phase: 'saving' });
    try {
      const args = card.kind === 'reply_draft'
        ? { proposal_id: card.id, base_version: card.revision, subject: card.subject, body: card.body, to: [...card.to], cc: [...card.cc], idempotency_key: key }
        : { draft_id: card.id, revision: card.revision, idempotency_key: key };
      const result = await request(card.kind === 'reply_draft' ? 'submit-email-draft' : 'approve-lead-draft', args, { signal, timeoutMs: 10_000 });
      if (signal.aborted) return;
      if (object(result) && result.kind === 'authorization') { setState({ kind: 'signed-out' }); return; }
      if (object(result) && result.kind === 'payload' && object(result.payload)) {
        const receipt = result.payload;
        if (result.isError || receipt.error) {
          const known = refusal(receipt.error);
          if (known) { setState(known); return; }
        } else if (card.kind === 'reply_draft'
          ? receipt.ok === true && receipt.proposal_id === card.id && receipt.version === card.revision + 1 && receipt.status === 'approved_to_send'
            && receipt.subject === card.subject && receipt.body === card.body && typeof receipt.sha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256)
            && JSON.stringify(receipt.to) === JSON.stringify(card.to) && JSON.stringify(receipt.cc) === JSON.stringify(card.cc)
          : receipt.ok === true && receipt.draft_id === card.id && receipt.revision === card.revision && receipt.approved === true && receipt.sent === false) {
          setState({ kind: 'approved', draftKind: card.kind }); return;
        }
      }
      setState({ kind: 'ready', card, key, phase: 'unknown' });
    } catch { if (!signal.aborted) setState({ kind: 'ready', card, key, phase: 'unknown' }); }
    finally { busy.current = false; }
  };
  const reply = state.kind === 'ready' && state.card.kind === 'reply_draft' || state.kind === 'approved' && state.draftKind === 'reply_draft';
  useEffect(() => { document.title = `${reply ? 'Review reply draft' : 'Review draft'} · DoctorCRE`; }, [reply]);
  const returnTo = `/a/${encodeURIComponent(ref)}`;
  return <><a className="action-link-back" href="/">← Home</a><header><p className="action-link-eyebrow">{reply ? 'Reply' : 'First contact'}</p><h1>{state.kind === 'approved' ? reply ? 'Reply submitted' : 'Draft approved' : reply ? 'Review reply draft' : 'Review draft'}</h1>{state.kind !== 'approved' && <p>{reply ? 'Review the message and recipients before submitting for sending.' : 'Read the message before approving it.'}</p>}</header>
    <section className="action-link-card" aria-busy={state.kind === 'loading' || state.kind === 'ready' && state.phase === 'saving'}>
      {state.kind === 'loading' && <p role="status">Opening draft…</p>}
      {state.kind === 'signed-out' && <><h2>Sign in to open this draft</h2><a className="btn" href={`/auth/login?return_to=${encodeURIComponent(returnTo)}`}>Sign in</a></>}
      {state.kind === 'unavailable' && <><p role="status">{state.message}</p>{state.retry && <button className="btn" onClick={() => setReload(value => value + 1)}>Reload draft</button>}</>}
      {state.kind === 'approved' && <><p role="status">{reply ? 'Reply submitted for sending. Delivery is not yet confirmed.' : 'Nothing was sent. The message remains a draft.'}</p><a className="btn" href={reply ? '/' : '/leads'}>{reply ? 'Go Home' : 'Go to Leads'}</a></>}
      {state.kind === 'ready' && <><p className="action-link-eyebrow">Awaiting your approval</p><h2 data-draft-subject>{state.card.subject || (reply ? 'Reply draft' : 'First-contact draft')}</h2>
        {state.card.kind === 'lead_draft' && state.card.scheduledFor && <p className="action-link-schedule">Planned for <time dateTime={state.card.scheduledFor}>{new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: state.card.timeZone }).format(new Date(state.card.scheduledFor))}</time> · {state.card.timeZone}</p>}
        {state.card.kind === 'reply_draft' && <><p data-draft-to>To: {state.card.to.join(', ')}</p><p data-draft-cc>CC: {state.card.cc.join(', ')}</p><p data-proposal-id={state.card.id}>Proposal: {state.card.id}</p></>}
        <div className="action-link-message">{state.card.body}</div><p>{reply ? 'Submit reply authorizes sending this exact message to these recipients.' : 'Approval keeps this as a draft. Nothing is sent.'}</p>
        {state.phase === 'unknown' && <p role="status">{reply ? 'Submission has not been confirmed. Retry the same submission to check its outcome.' : 'Approval has not been confirmed. Retry to check the same approval.'}</p>}
        <button className="btn" disabled={state.phase === 'saving'} onClick={() => void approve()}>{state.phase === 'saving' ? reply ? 'Submitting…' : 'Approving…' : state.phase === 'unknown' ? reply ? 'Retry submission' : 'Retry approval' : reply ? 'Submit reply for sending' : 'Approve draft'}</button>
      </>}
    </section></>;
}
export function mountActionLink(host: HTMLElement, options: { ref: string; request: Request }) {
  const root = createRoot(host);
  flushSync(() => root.render(<ActionLink {...options} />));
  return { dispose: () => flushSync(() => root.unmount()) };
}
