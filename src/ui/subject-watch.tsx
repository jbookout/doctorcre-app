import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type Subject = { subject_type: 'deal' | 'lease'; subject_id: string };
type Request = Subject & { idempotency_key: string };
type Pending = { command: 'watch' | 'unwatch'; request: Request };
type Client = {
  readSubjectWatch(args: Subject, options: { signal: AbortSignal }): Promise<unknown>;
  watchSubject(args: Request, options: { signal: AbortSignal }): Promise<unknown>;
  unwatchSubject(args: Request, options: { signal: AbortSignal }): Promise<unknown>;
};
type State = { kind: 'reading' | 'unavailable' | 'expired' }
  | { kind: 'ready'; watching: boolean }
  | { kind: 'saving' | 'uncertain'; pending: Pending };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === 'string' && uuid.test(v);

function parseWatch(value: unknown, subject: Subject, command?: Pending['command']): boolean {
  if (!record(value) || value.ok !== true || value.schema_version !== 'subject-watch.v1'
    || !Object.hasOwn(value, 'watch') || (command && value.rows_changed !== 0 && value.rows_changed !== 1)) throw Error('Invalid watch response');
  if (value.watch === null) {
    if (command === 'watch') throw Error('Missing watch receipt');
    return false;
  }
  const watch = value.watch;
  if (command === 'unwatch' || !record(watch) || !validId(watch.id) || !validId(watch.actor_id)
    || watch.subject_type !== subject.subject_type || watch.subject_id !== subject.subject_id
    || typeof watch.subscribed_at !== 'string' || !Number.isFinite(Date.parse(watch.subscribed_at))
    || !record(watch.baseline) || watch.baseline.schema_version !== 'subject-watch-baseline.v1'
    || watch.baseline.subject_type !== subject.subject_type || watch.baseline.subject_id !== subject.subject_id
    || typeof watch.baseline.version !== 'number' || !Number.isSafeInteger(watch.baseline.version) || watch.baseline.version < 1) throw Error('Invalid watch');
  return true;
}

export function mountSubjectWatch(element: Element, { subject, actor, client }: { subject: Subject; actor: string; client: Client }) {
  if (!validId(subject.subject_id) || !['deal', 'lease'].includes(subject.subject_type) || !actor) throw Error('Canonical watch identity required');
  const root = createRoot(element), view = element.ownerDocument.defaultView;
  const storageKey = `doctorcre.watch.${JSON.stringify([actor, subject.subject_type, subject.subject_id])}`;
  let state: State = { kind: 'reading' }, disposed = false, generation = 0;
  let controller = new AbortController();
  function expire() {
    ++generation; controller.abort();
    try { view?.sessionStorage.removeItem(storageKey); } catch { /* Storage can be disabled. */ }
    state = { kind: 'expired' }; render();
  }
  view?.addEventListener('doctorcre-session-invalidated', expire);
  function render() {
    if (disposed) return;
    const busy = state.kind === 'reading' || state.kind === 'saving';
    const label = state.kind === 'ready' ? state.watching ? 'Unwatch' : 'Watch'
      : state.kind === 'unavailable' ? 'Retry watch status'
      : state.kind === 'uncertain' ? 'Check watch result'
      : state.kind === 'saving' ? 'Saving watch…' : 'Checking watch status…';
    const message = state.kind === 'ready' ? state.watching ? 'Watching' : 'Not watching'
      : state.kind === 'unavailable' ? 'Watch status unavailable.'
      : state.kind === 'uncertain' ? 'Watch result unknown. Check before making another change.'
      : state.kind === 'expired' ? 'Sign in again to view watches.' : label;
    flushSync(() => root.render(<section className="subject-watch" aria-label={`Watch this ${subject.subject_type}`}>
      <p role="status" aria-live="polite">{message}</p>
      {state.kind !== 'expired' && <button type="button" className="btn" disabled={busy} onClick={() => {
        if (state.kind === 'ready') {
          const pending: Pending = { command: state.watching ? 'unwatch' : 'watch', request: { ...subject, idempotency_key: crypto.randomUUID() } };
          try { view?.sessionStorage.setItem(storageKey, JSON.stringify(pending)); }
          catch { state = { kind: 'unavailable' }; render(); return; }
          void save(pending);
        } else if (state.kind === 'uncertain') void save(state.pending);
        else if (state.kind === 'unavailable') void read();
      }}>{label}</button>}
      <p className="subject-watch-explanation">Watches notify you only when this record changes.</p>
    </section>));
  }
  function current(ticket: number) { return !disposed && ticket === generation; }
  function denied(error: unknown) { return record(error) && (error.status === 401 || error.status === 403 || error.code === 'session_changed'); }
  async function read() {
    if (disposed || state.kind === 'expired') return;
    const ticket = ++generation; controller.abort(); controller = new AbortController();
    state = { kind: 'reading' }; render();
    try {
      const value = await client.readSubjectWatch(subject, { signal: controller.signal });
      if (!current(ticket)) return;
      state = { kind: 'ready', watching: parseWatch(value, subject) };
    } catch (error) {
      if (!current(ticket)) return;
      if (denied(error)) { expire(); return; }
      state = { kind: 'unavailable' };
    }
    render();
  }
  async function save(pending: Pending) {
    if (disposed || state.kind === 'expired') return;
    const ticket = ++generation; controller.abort(); controller = new AbortController();
    state = { kind: 'saving', pending }; render();
    try {
      const method = pending.command === 'watch' ? client.watchSubject : client.unwatchSubject;
      const value = await method.call(client, pending.request, { signal: controller.signal });
      if (!current(ticket)) return;
      parseWatch(value, subject, pending.command);
      view?.sessionStorage.removeItem(storageKey);
    } catch (error) {
      if (!current(ticket)) return;
      if (denied(error)) { expire(); return; }
      state = { kind: 'uncertain', pending }; render(); return;
    }
    await read();
  }
  let retained: Pending | null = null;
  try {
    const stored: unknown = JSON.parse(view?.sessionStorage.getItem(storageKey) || 'null');
    if (record(stored) && (stored.command === 'watch' || stored.command === 'unwatch') && record(stored.request)
      && validId(stored.request.idempotency_key) && stored.request.subject_id === subject.subject_id && stored.request.subject_type === subject.subject_type) {
      retained = { command: stored.command, request: { ...subject, idempotency_key: stored.request.idempotency_key } };
    }
  } catch { /* A missing retained request still permits server reads. */ }
  if (retained) void save(retained); else void read();
  return { dispose() { disposed = true; ++generation; controller.abort(); view?.removeEventListener('doctorcre-session-invalidated', expire); root.unmount(); } };
}
