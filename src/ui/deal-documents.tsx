import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DealDeliverables } from "./deal-deliverables.tsx";
import type { DocumentTextClient } from "./deal-document-text";
import { DocumentTextViewer } from "./deal-document-text-viewer";

import type { QuoteAskClient } from "./document-quote-next-ask";

type Document = {
  id: string;
  display_name: string;
  document_type: string | null;
  page_count: number | null;
  content_hash: string;
  stored_at: string;
};
type TypeSelection = { kind: "all" } | { kind: "type"; value: string | null };
type Page = { documents: Document[]; next: string | null };
type State =
  | { kind: "expired" }
  | { kind: "loading" | "ready" | "more" | "unavailable"; page: Page; cursor: string | null };
type Client = Partial<DocumentTextClient> &
  Partial<QuoteAskClient> & {
    listDealDocuments(
      args: { deal_id: string; limit: number; cursor?: string },
      options: { signal: AbortSignal },
    ): Promise<unknown>;
  };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const PAGE_SIZE = 50,
  MAX_DOCUMENTS = 500;
function parsePage(value: unknown): Page {
  if (
    !record(value) ||
    value.ok !== true ||
    value.schema_version !== "deal-documents.v1" ||
    !Array.isArray(value.documents) ||
    value.documents.length > PAGE_SIZE ||
    typeof value.has_more !== "boolean" ||
    (value.has_more
      ? typeof value.next_cursor !== "string" || !value.next_cursor || value.next_cursor.length > 1000
      : value.next_cursor !== null)
  )
    throw Error("Invalid document page");
  const documents = value.documents.map((row: unknown): Document => {
    if (
      !record(row) ||
      typeof row.id !== "string" ||
      !uuid.test(row.id) ||
      typeof row.display_name !== "string" ||
      !row.display_name.trim() ||
      typeof row.content_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.content_hash) ||
      typeof row.stored_at !== "string" ||
      !Number.isFinite(Date.parse(row.stored_at)) ||
      (row.document_type !== null && typeof row.document_type !== "string") ||
      (row.page_count !== null &&
        (!Number.isSafeInteger(row.page_count) || typeof row.page_count !== "number" || row.page_count < 1))
    )
      throw Error("Invalid document");
    return {
      id: row.id,
      display_name: row.display_name,
      document_type: row.document_type,
      page_count: row.page_count,
      content_hash: row.content_hash,
      stored_at: row.stored_at,
    };
  });
  return { documents, next: typeof value.next_cursor === "string" ? value.next_cursor : null };
}

export function mountDealDocuments(element: Element, { dealId, client }: { dealId: string; client: Client }) {
  if (!uuid.test(dealId)) throw Error("Invalid deal");
  const { askSession, submitDocRequest, listDocConversations, readDocConversation } = client;
  const quoteClient: QuoteAskClient | null =
    askSession && submitDocRequest && listDocConversations && readDocConversation
      ? { askSession, submitDocRequest, listDocConversations, readDocConversation }
      : null;
  const root = createRoot(element);
  let state: State = { kind: "loading", page: { documents: [], next: null }, cursor: null },
    disposed = false,
    generation = 0;
  let pendingUpload = false;
  const uploadPending = (value: boolean) => {
    pendingUpload = value;
  };
  let opened: Document | null = null;
  let openedButton: HTMLButtonElement | null = null;
  let search = "",
    selection: TypeSelection = { kind: "all" };
  let searchInput: HTMLInputElement | null = null;
  function clearSelection() {
    search = "";
    selection = { kind: "all" };
  }
  let controller = new AbortController();
  const cursors = new Set<string>();
  const view = element.ownerDocument.defaultView;
  function expire() {
    opened = null;
    pendingUpload = false;
    ++generation;
    controller.abort();
    clearSelection();
    cursors.clear();
    state = { kind: "expired" };
    render();
  }
  view?.addEventListener("doctorcre-session-invalidated", expire);
  function render() {
    if (disposed) return;
    const page = "page" in state ? state.page : null;
    const types = [...new Set(page?.documents.map((doc) => doc.document_type) || [])];
    const unrecordedLabel = types.reduce<string>(
      (label) => (types.includes(label) ? `${label} (unrecorded)` : label),
      "Unrecorded",
    );
    const query = search.trim().toLowerCase();
    const matches =
      page?.documents.filter(
        (doc) =>
          doc.display_name.toLowerCase().includes(query) &&
          (selection.kind === "all" || doc.document_type === selection.value),
      ) || [];
    const busy = state.kind === "loading" || state.kind === "more";
    flushSync(() =>
      root.render(
        <section className="deal-documents" aria-label="Deal documents">
          {state.kind !== "expired" && <DealDeliverables key={dealId} dealId={dealId} pending={uploadPending} />}
          <h2>Documents</h2>
          <p>Files filed for this deal. Open retained text to read extracted pages and lines.</p>
          {state.kind !== "expired" && (
            <button className="btn" type="button" disabled={busy} onClick={() => void refresh()}>
              Refresh documents
            </button>
          )}
          {page && (
            <div>
              <label>
                Search loaded documents{" "}
                <input
                  type="search"
                  ref={(input) => {
                    searchInput = input;
                  }}
                  value={search}
                  onChange={(event) => {
                    search = event.target.value;
                    render();
                  }}
                />
              </label>
              <label>
                Document type{" "}
                <select
                  value={
                    selection.kind === "all" ? "all" : selection.value === null ? "null" : `type:${selection.value}`
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    selection =
                      value === "all"
                        ? { kind: "all" }
                        : { kind: "type", value: value === "null" ? null : value.slice(5) };
                    render();
                  }}
                >
                  <option value="all">All types</option>
                  {types.map((type) => (
                    <option
                      key={type === null ? "null" : `type:${type}`}
                      value={type === null ? "null" : `type:${type}`}
                    >
                      {type === null ? unrecordedLabel : type}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  clearSelection();
                  render();
                  searchInput?.focus();
                }}
              >
                Clear
              </button>
            </div>
          )}
          <div role="status" aria-live="polite">
            {page && (
              <p>
                {matches.length} matching of {page.documents.length} loaded documents.
              </p>
            )}
            {page && !!page.documents.length && !matches.length && (
              <p>
                No matching loaded documents. Search covers loaded documents only.
                {page.next ? " More pages may exist. Use Load more documents to search additional documents." : ""}
              </p>
            )}
            {busy && <p>Loading documents…</p>}
            {(state.kind === "loading" || state.kind === "unavailable") &&
              state.cursor === null &&
              !!page?.documents.length && <p>Last successful read. Documents may be out of date.</p>}
            {state.kind === "expired" && <p>Session expired. Sign in again to view documents.</p>}
            {state.kind === "unavailable" && (
              <p>
                Documents unavailable.{" "}
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    if (state.kind === "unavailable") void load(state.page, state.cursor);
                  }}
                >
                  Retry documents
                </button>
              </p>
            )}
            {state.kind === "ready" && !state.page.documents.length && <p>No documents filed for this deal.</p>}
          </div>
          {page && (
            <ul className="deal-document-list">
              {matches.map((doc) => (
                <li key={doc.id} data-document-id={doc.id} data-content-hash={doc.content_hash}>
                  <h3>{doc.display_name}</h3>
                  <p>
                    {doc.document_type || "Document"} · Stored{" "}
                    <time dateTime={doc.stored_at}>{new Date(doc.stored_at).toLocaleDateString()}</time>
                    {doc.page_count === null ? "" : ` · ${doc.page_count} pages`}
                  </p>
                  <button
                    className="btn"
                    type="button"
                    onClick={(event) => {
                      openedButton = event.currentTarget;
                      opened = doc;
                      render();
                    }}
                  >
                    Open text for {doc.display_name}
                  </button>
                  <details>
                    <summary>Document identity</summary>
                    <dl>
                      <dt>Document UUID</dt>
                      <dd>{doc.id}</dd>
                      <dt>SHA-256</dt>
                      <dd>{doc.content_hash}</dd>
                    </dl>
                  </details>
                </li>
              ))}
            </ul>
          )}
          {opened && (
            <DocumentTextViewer
              key={dealId + opened.id + opened.content_hash}
              quoteClient={quoteClient}
              source={{
                deal_id: dealId,
                attachment_id: opened.id,
                content_hash: opened.content_hash,
                filename: opened.display_name,
              }}
              client={{
                readDealDocumentText: (args, options) =>
                  client.readDealDocumentText
                    ? client.readDealDocumentText(args, options)
                    : Promise.reject(Error("Text reader unavailable")),
              }}
              onClose={() => {
                opened = null;
                render();
                openedButton?.focus();
              }}
            />
          )}
          {state.kind === "ready" &&
            page &&
            (page.documents.length < MAX_DOCUMENTS ? (
              page.next && (
                <button className="btn" type="button" onClick={() => void load(page, page.next)}>
                  Load more documents
                </button>
              )
            ) : (
              <p>Showing the first {MAX_DOCUMENTS} documents. Refresh to start again.</p>
            ))}
        </section>,
      ),
    );
  }
  async function load(previous: Page, cursor: string | null) {
    if (disposed || state.kind === "expired") return;
    const ticket = ++generation;
    controller.abort();
    controller = new AbortController();
    state = cursor ? { kind: "more", page: previous, cursor } : { kind: "loading", page: previous, cursor: null };
    render();
    const scanned = cursor ? previous.documents : [];
    try {
      const value = await client.listDealDocuments(
        { deal_id: dealId, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
        { signal: controller.signal },
      );
      if (disposed || ticket !== generation) return;
      const page = parsePage(value);
      const ids = new Set(scanned.map((doc) => doc.id.toLowerCase()));
      for (const doc of page.documents) {
        if (ids.has(doc.id.toLowerCase())) throw Error("Repeated document");
        ids.add(doc.id.toLowerCase());
      }
      if (page.next && (page.next === cursor || cursors.has(page.next) || !page.documents.length))
        throw Error("Repeated cursor");
      if (cursor) cursors.add(cursor);
      const documents = [...scanned, ...page.documents.slice(0, MAX_DOCUMENTS - scanned.length)];
      if (
        selection.kind === "type" &&
        !documents.some((doc) => selection.kind === "type" && doc.document_type === selection.value)
      )
        selection = { kind: "all" };
      state = { kind: "ready", page: { documents, next: page.next }, cursor: null };
    } catch (error) {
      if (disposed || ticket !== generation) return;
      if (record(error) && (error.status === 401 || error.status === 403)) {
        expire();
        return;
      }
      state = { kind: "unavailable", page: previous, cursor };
    }
    render();
  }
  function refresh() {
    if (state.kind === "more" || (state.kind === "loading" && generation > 0)) return;
    opened = null;
    cursors.clear();
    return load("page" in state ? state.page : { documents: [], next: null }, null);
  }
  void refresh();
  return {
    refresh,
    hasUnsavedChanges: () => pendingUpload,
    confirmLeave: () =>
      !pendingUpload ||
      view?.confirm(
        "A file or designation is pending. Stay to finish it. Leaving keeps unresolved reservations bound to this deal; unuploaded bytes must be selected again. Leave this deal?",
      ) === true,
    dispose() {
      opened = null;
      disposed = true;
      clearSelection();
      cursors.clear();
      state = { kind: "expired" };
      searchInput = null;
      ++generation;
      controller.abort();
      view?.removeEventListener("doctorcre-session-invalidated", expire);
      root.unmount();
    },
  };
}
