import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Request = (name: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>;
type Draft = { id: string; revision: number; subject: string; body: string; scheduledFor: string | null; timeZone: string };
type State = { kind: 'loading' } | { kind: 'ready'; card: Draft; key: string; phase: 'idle' | 'saving' | 'unknown' }
  | { kind: 'approved' } | { kind: 'unavailable'; message: string; retry: boolean } | { kind: 'signed-out' };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function parseDraft(payload: unknown, ref: string): Draft | null {
  if (!object(payload) || payload.schema_version !== 'action-link-resolve.v1' || payload.ref !== ref || !object(payload.card)) return null;
  const card = payload.card;
  if (card.kind !== 'lead_draft' || card.state !== 'pending_approval' || !uuid(card.id) || !uuid(card.lead_id)
    || typeof card.revision !== 'number' || !Number.isSafeInteger(card.revision) || card.revision < 1
    || typeof card.subject !== 'string' || typeof card.body !== 'string' || typeof card.time_zone !== 'string'
    || !(card.scheduled_for === null || typeof card.scheduled_for === 'string' && Number.isFinite(Date.parse(card.scheduled_for)))
    || !Array.isArray(card.actions) || card.actions.length !== 1) return null;
  const action: unknown = card.actions[0];
  if (!object(action) || action.action !== 'approve' || action.verb !== 'approve-lead-draft' || !object(action.args)
    || action.args.draft_id !== card.id || action.args.revision !== card.revision) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: card.time_zone }); } catch { return null; }
  return { id: card.id, revision: card.revision, subject: card.subject, body: card.body, scheduledFor: card.scheduled_for, timeZone: card.time_zone };
}
function refusal(code: unknown): State | null {
  // eslint-disable-next-line no-restricted-syntax -- Unavailable action links set retry=false; 0 automatic resolve requests.
  if (code === 'action_link_not_found') return { kind: 'unavailable', message: 'This draft is unavailable for your account.', retry: false };
  // eslint-disable-next-line no-restricted-syntax -- No-longer-actionable drafts set retry=false; 0 automatic resolve or approval attempts.
  if (['action_link_no_longer_actionable', 'draft_not_pending'].includes(String(code))) return { kind: 'unavailable', message: 'This draft is no longer awaiting approval.', retry: false };
  // eslint-disable-next-line no-restricted-syntax -- Stale draft revision offers manual reload; 0 automatic approvals of the changed draft.
  if (code === 'stale_draft_revision') return { kind: 'unavailable', message: 'This draft changed. Reload it before approving.', retry: true };
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
        // eslint-disable-next-line no-restricted-syntax -- Invalid action-link references set retry=false and send 0 resolve requests.
        setState({ kind: 'unavailable', message: 'This draft link is invalid.', retry: false }); return;
      }
      try {
        const result = await request('resolve-action-link', { ref }, { signal: controller.signal, timeoutMs: 10_000 });
        if (controller.signal.aborted) return;
        if (object(result) && result.kind === 'authorization') { setState({ kind: 'signed-out' }); return; }
        if (object(result) && result.kind === 'payload') {
          const payload = result.payload;
          if (object(payload) && (result.isError || payload.error)) {
            // eslint-disable-next-line no-restricted-syntax -- Refused resolve result offers 1 manual reload; 0 scheduled retries.
            setState(refusal(payload.error) || { kind: 'unavailable', message: 'The draft could not be opened.', retry: true }); return;
          }
          const card = parseDraft(payload, ref);
          if (card) { setState({ kind: 'ready', card, key: crypto.randomUUID(), phase: 'idle' }); return; }
        }
        // eslint-disable-next-line no-restricted-syntax -- Malformed draft result offers manual reload; 0 scheduled resolve retries.
        setState({ kind: 'unavailable', message: 'The draft could not be opened.', retry: true });
      // eslint-disable-next-line no-restricted-syntax -- Resolve failure offers manual reload unless aborted; 0 scheduled retries.
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
      const result = await request('approve-lead-draft', { draft_id: card.id, revision: card.revision, idempotency_key: key }, { signal, timeoutMs: 10_000 });
      if (signal.aborted) return;
      if (object(result) && result.kind === 'authorization') { setState({ kind: 'signed-out' }); return; }
      if (object(result) && result.kind === 'payload' && object(result.payload)) {
        const receipt = result.payload;
        if (result.isError || receipt.error) {
          const known = refusal(receipt.error);
          if (known) { setState(known); return; }
        } else if (receipt.ok === true && receipt.draft_id === card.id && receipt.revision === card.revision && receipt.approved === true && receipt.sent === false) {
          setState({ kind: 'approved' }); return;
        }
      }
      setState({ kind: 'ready', card, key, phase: 'unknown' });
    } catch { if (!signal.aborted) setState({ kind: 'ready', card, key, phase: 'unknown' }); }
    finally { busy.current = false; }
  };
  const returnTo = `/a/${encodeURIComponent(ref)}`;
  return <><a className="action-link-back" href="/">← Home</a><header><p className="action-link-eyebrow">First contact</p><h1>{state.kind === 'approved' ? 'Draft approved' : 'Review draft'}</h1>{state.kind !== 'approved' && <p>Read the message before approving it.</p>}</header>
    <section className="action-link-card" aria-busy={state.kind === 'loading' || state.kind === 'ready' && state.phase === 'saving'}>
      {state.kind === 'loading' && <p role="status">Opening draft…</p>}
      {state.kind === 'signed-out' && <><h2>Sign in to open this draft</h2><a className="btn" href={`/auth/login?return_to=${encodeURIComponent(returnTo)}`}>Sign in</a></>}
      {state.kind === 'unavailable' && <><p role="status">{state.message}</p>{state.retry && <button className="btn" onClick={() => setReload(value => value + 1)}>Reload draft</button>}</>}
      {state.kind === 'approved' && <><p role="status">Nothing was sent. The message remains a draft.</p><a className="btn" href="/leads">Go to Leads</a></>}
      {state.kind === 'ready' && <><p className="action-link-eyebrow">Awaiting your approval</p><h2>{state.card.subject || 'First-contact draft'}</h2>
        {state.card.scheduledFor && <p className="action-link-schedule">Planned for <time dateTime={state.card.scheduledFor}>{new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: state.card.timeZone }).format(new Date(state.card.scheduledFor))}</time> · {state.card.timeZone}</p>}
        <div className="action-link-message">{state.card.body}</div><p>Approval keeps this as a draft. Nothing is sent.</p>
        {state.phase === 'unknown' && <p role="status">Approval has not been confirmed. Retry to check the same approval.</p>}
        <button className="btn" disabled={state.phase === 'saving'} onClick={() => void approve()}>{state.phase === 'saving' ? 'Approving…' : state.phase === 'unknown' ? 'Retry approval' : 'Approve draft'}</button>
      </>}
    </section></>;
}
export function mountActionLink(host: HTMLElement, options: { ref: string; request: Request }) {
  const root = createRoot(host);
  flushSync(() => root.render(<ActionLink {...options} />));
  return { dispose: () => flushSync(() => root.unmount()) };
}
