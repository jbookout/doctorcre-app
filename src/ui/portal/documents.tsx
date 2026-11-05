import { useEffect, useState } from 'react';

type Material = { kind: 'document' | 'tour' | 'report'; title: string; content: string };
type Closed = { kind: 'refused' | 'expired' | 'withdrawn' | 'unavailable' };
type State = Closed | { kind: 'loading' | 'empty' | 'hidden' } | { kind: 'ready'; materials: Material[] };
export type DocumentsTransport = (request: { slug: string; signal: AbortSignal }) => Promise<Closed | { kind: 'received'; payload: unknown }>;
type Props = { portalSlug: string; sessionScope: string; transport: DocumentsTransport };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit: number): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value.replace(/^ +| +$/g, '')].length;
  return length > 0 && length <= limit;
}

export function parseDocuments(payload: unknown, slug: string): State {
  if (!record(payload) || payload.ok !== true || payload.schema_version !== 'client-portal.v1' ||
      !record(payload.portal) || payload.portal.slug !== slug || !Array.isArray(payload.portal.materials) ||
      payload.portal.materials.length > 100) return { kind: 'refused' };
  const materials: Material[] = [];
  for (const item of payload.portal.materials) {
    if (!record(item) || (item.kind !== 'document' && item.kind !== 'tour' && item.kind !== 'report') ||
        !text(item.title, 200) || !text(item.content, 10000)) return { kind: 'refused' };
    materials.push({ kind: item.kind, title: item.title, content: item.content });
  }
  return materials.length ? { kind: 'ready', materials } : { kind: 'empty' };
}

const messages = {
  loading: 'Loading shared materials…',
  empty: 'No materials are shared with you yet.',
  refused: 'These materials are not available to this portal session.',
  expired: 'Your portal session has expired. Sign in again to view materials.',
  withdrawn: 'These shared materials have been withdrawn.',
  unavailable: 'Shared materials are temporarily unavailable. Please try again.',
  hidden: 'Return to this page to reload shared materials.',
};

export function Documents(props: Props) {
  return <DocumentsSession key={JSON.stringify([props.portalSlug, props.sessionScope])} {...props} />;
}

function DocumentsSession({ portalSlug, transport }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancel = () => {};
    function load() {
      cancel();
      if (document.visibilityState === 'hidden') {
        setState({ kind: 'hidden' });
        return;
      }
      setState({ kind: 'loading' });
      const controller = new AbortController();
      let active = true;
      // eslint-disable-next-line no-restricted-syntax -- One 10000ms deadline per read; canceled on refresh, hide and unmount; never schedules another request.
      const timer = setTimeout(() => {
        active = false;
        controller.abort();
        setState({ kind: 'unavailable' });
      }, 10000);
      cancel = () => { active = false; clearTimeout(timer); controller.abort(); };
      Promise.resolve().then(() => transport({ slug: portalSlug, signal: controller.signal })).then(result => {
        if (!active) return;
        clearTimeout(timer);
        setState(result.kind === 'received' ? parseDocuments(result.payload, portalSlug) : result);
      }).catch(() => {
        if (!active) return;
        clearTimeout(timer);
        setState({ kind: 'unavailable' });
      });
    }
    load();
    // eslint-disable-next-line no-restricted-syntax -- One read on visible return; hidden pages abort and clear; no polling or automatic retry.
    document.addEventListener('visibilitychange', load);
    return () => { cancel(); document.removeEventListener('visibilitychange', load); };
  }, [portalSlug, transport, attempt]);
  return <section className="portal-documents" aria-label="Documents" aria-busy={state.kind === 'loading'}>
    <h2>Documents</h2>
    <p>Documents and deliverables your CARR team has shared with you.</p>
    <button type="button" disabled={state.kind === 'loading' || state.kind === 'hidden'} onClick={() => {
      setState({ kind: 'loading' });
      setAttempt(value => value + 1);
    }}>Refresh materials</button>
    {state.kind === 'ready' ? <ul style={{ paddingInlineStart: '1.25rem' }}>
      {state.materials.map((material, index) => <li key={index} style={{ marginBlock: '1.25rem', overflowWrap: 'anywhere' }}>
        <article>
          <p>{material.kind === 'document' ? 'Document' : `Generated deliverable · ${material.kind === 'tour' ? 'Tour' : 'Report'}`}</p>
          <h3>{material.title}</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{material.content}</p>
          <p>File unavailable.</p>
        </article>
      </li>)}
    </ul> : <p role="status">{messages[state.kind]}</p>}
  </section>;
}
