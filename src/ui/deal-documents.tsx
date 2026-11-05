import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { FILE_ACCEPT, draftStore, stageFiles, bindActor } from './share-draft-store';

type Document = { id: string; display_name: string; document_type: string | null; page_count: number | null; content_hash: string; stored_at: string };
type Page = { documents: Document[]; next: string | null };
type State = { kind: 'loading' } | { kind: 'expired' } | { kind: 'ready' | 'more' | 'unavailable'; page: Page; cursor: string | null };
type Client = { listDealDocuments(args: { deal_id: string; limit: number; cursor?: string }, options: { signal: AbortSignal }): Promise<unknown> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const PAGE_SIZE = 50, MAX_DOCUMENTS = 500;
function parsePage(value: unknown): Page {
  if (!record(value) || value.ok !== true || value.schema_version !== 'deal-documents.v1' || !Array.isArray(value.documents)
    || value.documents.length > PAGE_SIZE || typeof value.has_more !== 'boolean'
    || (value.has_more ? typeof value.next_cursor !== 'string' || !value.next_cursor || value.next_cursor.length > 1000 : value.next_cursor !== null)) throw Error('Invalid document page');
  const documents = value.documents.map((row: unknown): Document => {
    if (!record(row) || typeof row.id !== 'string' || !uuid.test(row.id) || typeof row.display_name !== 'string' || !row.display_name.trim()
      || typeof row.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.content_hash)
      || typeof row.stored_at !== 'string' || !Number.isFinite(Date.parse(row.stored_at))
      || (row.document_type !== null && typeof row.document_type !== 'string')
      || (row.page_count !== null && (!Number.isSafeInteger(row.page_count) || typeof row.page_count !== 'number' || row.page_count < 1))) throw Error('Invalid document');
    return { id: row.id, display_name: row.display_name, document_type: row.document_type, page_count: row.page_count, content_hash: row.content_hash, stored_at: row.stored_at };
  });
  return { documents, next: typeof value.next_cursor === 'string' ? value.next_cursor : null };
}

export function mountDealDocuments(element: Element, { dealId, actor, client }: { dealId: string; actor?: string; client: Client }) {
  if (!uuid.test(dealId)) throw Error('Invalid deal');
  const root = createRoot(element);
  let state: State = { kind: 'loading' }, disposed = false, generation = 0;
  let controller = new AbortController();
  let staging = false, uploadMessage = '';
  const retired = () => disposed || state.kind === 'expired';
  async function stage(files: File[]) {
    if (disposed || state.kind === 'expired' || !actor || staging) return;
    staging = true; render();
    try {
      const draft = await stageFiles(files);
      if (retired()) return;
      bindActor(draft, actor); draft.selected_deal_id = dealId;
      await draftStore().save(draft, true);
      if (retired()) { await draftStore().clear(); return; }
      location.assign(`/share-to-deal?draft=${draft.draft_id}`);
    } catch { uploadMessage = 'Files were not staged. Open pending files or reselect.'; }
    finally { staging = false; render(); }
  }
  const cursors = new Set<string>();
  const view = element.ownerDocument.defaultView;
  function expire() {
    ++generation; controller.abort(); state = { kind: 'expired' }; void draftStore().clear(); render();
  }
  view?.addEventListener('doctorcre-session-invalidated', expire);
  function render() {
    if (disposed) return;
    const page = 'page' in state ? state.page : null;
    const busy = state.kind === 'loading' || state.kind === 'more';
    flushSync(() => root.render(<section className="deal-documents" aria-label="Deal documents">
      <h2>Documents</h2>
      <p>Files filed for this deal. Downloads are not available here.</p>
      {actor && state.kind !== 'expired' && <>
        <p>On iPhone and Safari, use Upload documents to open Files or Photos. Receiving files from the system share sheet is unsupported.</p>
        <label className="btn" style={{ maxWidth: '100%', flexWrap: 'wrap' }}>Upload documents<input style={{ maxWidth: '100%', minWidth: 0 }} aria-label="Upload documents" type="file" multiple accept={FILE_ACCEPT} disabled={staging} onChange={event => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; if (files.length) void stage(files); }} /></label>
        <p role="status">{uploadMessage}</p><a href="/share-to-deal">Open pending files</a>
      </>}
      {state.kind !== 'expired' && <button className="btn" type="button" disabled={busy} onClick={() => void refresh()}>Refresh documents</button>}
      <div role="status" aria-live="polite">
        {busy && <p>Loading documents…</p>}
        {state.kind === 'expired' && <p>Session expired. Sign in again to view documents.</p>}
        {state.kind === 'unavailable' && <p>Documents unavailable. <button className="btn" type="button" onClick={() => { if (state.kind === 'unavailable') void load(state.page, state.cursor); }}>Retry documents</button></p>}
        {state.kind === 'ready' && !state.page.documents.length && <p>No documents filed for this deal.</p>}
      </div>
      {page && <ul className="deal-document-list">{page.documents.map(doc => <li key={doc.id} data-document-id={doc.id} data-content-hash={doc.content_hash}>
        <h3>{doc.display_name}</h3><p>{doc.document_type || 'Document'} · Stored <time dateTime={doc.stored_at}>{new Date(doc.stored_at).toLocaleDateString()}</time>{doc.page_count === null ? '' : ` · ${doc.page_count} pages`}</p>
        <details><summary>Document identity</summary><dl><dt>Document UUID</dt><dd>{doc.id}</dd><dt>SHA-256</dt><dd>{doc.content_hash}</dd></dl></details>
      </li>)}</ul>}
      {state.kind === 'ready' && page?.next && (page.documents.length < MAX_DOCUMENTS
        ? <button className="btn" type="button" onClick={() => void load(page, page.next)}>Load more documents</button>
        : <p>Showing the first {MAX_DOCUMENTS} documents. Refresh to start again.</p>)}
    </section>));
  }
  async function load(previous: Page, cursor: string | null) {
    if (retired()) return;
    const ticket = ++generation; controller.abort(); controller = new AbortController();
    state = cursor ? { kind: 'more', page: previous, cursor } : { kind: 'loading' }; render();
    try {
      const value = await client.listDealDocuments({ deal_id: dealId, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }, { signal: controller.signal });
      if (disposed || ticket !== generation) return;
      const page = parsePage(value);
      const ids = new Set(previous.documents.map(doc => doc.id.toLowerCase()));
      for (const doc of page.documents) {
        if (ids.has(doc.id.toLowerCase())) throw Error('Repeated document');
        ids.add(doc.id.toLowerCase());
      }
      if (page.next && (page.next === cursor || cursors.has(page.next) || !page.documents.length)) throw Error('Repeated cursor');
      if (cursor) cursors.add(cursor);
      state = { kind: 'ready', page: { documents: [...previous.documents, ...page.documents], next: page.next }, cursor: null };
    } catch (error) {
      if (disposed || ticket !== generation) return;
      if (record(error) && (error.status === 401 || error.status === 403)) { expire(); return; }
      state = { kind: 'unavailable', page: previous, cursor };
    }
    render();
  }
  function refresh() {
    if (state.kind === 'more' || state.kind === 'loading' && generation > 0) return;
    cursors.clear(); return load({ documents: [], next: null }, null);
  }
  void refresh();
  return { refresh, dispose() { disposed = true; ++generation; controller.abort(); view?.removeEventListener('doctorcre-session-invalidated', expire); root.unmount(); } };
}
