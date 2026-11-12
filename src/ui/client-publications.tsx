import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Command, Portal, Publication, Request, Visible } from "./client-publication-contract.ts";
import {
  commandFor,
  envelope,
  parsePortal,
  parsePublications,
  publicationFailure,
} from "./client-publication-contract.ts";
import { parseDeliverableList } from "./deal-deliverable-contract.ts";

export { createPublicationFixture } from "./client-publication-fixture.ts";

type Snapshot = { rows: Publication[]; portal: Portal | null; files: ReturnType<typeof parseDeliverableList> };
type State =
  | { kind: "loading" }
  | { kind: "ready"; data: Snapshot }
  | { kind: "saving" }
  | { kind: "uncertain"; command: Command }
  | { kind: "refused"; message: string }
  | { kind: "unavailable" }
  | { kind: "closed" };
function titleForFile(filename: string) {
  let title = "";
  for (const character of filename.trim()) {
    if (title.length + character.length > 200) break;
    title += character;
  }
  return title;
}
export function mountClientPublications(element: Element, { dealId, request }: { dealId: string; request: Request }) {
  const root = createRoot(element);
  let state: State = { kind: "loading" },
    generation = 0,
    disposed = false;
  let controller = new AbortController();
  function invalidate() {
    ++generation;
    controller.abort();
    state = { kind: "closed" };
    render();
  }
  const view = element.ownerDocument.defaultView;
  view?.addEventListener("doctorcre-session-invalidated", invalidate);
  function items(rows: Visible[]) {
    const occurrences = new Map<string, number>();
    return rows.map((row) => {
      const identity = JSON.stringify(row);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return (
        <article className="client-publication-item" key={`${identity}:${occurrence}`}>
          <small>{row.kind}</small>
          <h4>{row.title}</h4>
          {row.kind === "deliverable" ? (
            <p>
              {row.deliverable.filename} · {row.deliverable.mime} · {row.deliverable.bytes} bytes
            </p>
          ) : (
            <p className="note-original">{row.content}</p>
          )}
        </article>
      );
    });
  }
  function render() {
    if (disposed) return;
    const canPublish = state.kind === "ready" && state.data.portal !== null;
    flushSync(() =>
      root.render(
        <section className="client-publications" aria-label="Client publishing">
          <h2>Client view</h2>
          <p>Preview the published portal. Drafts stay hidden until you choose Publish.</p>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={state.kind === "loading" || state.kind === "saving" || state.kind === "closed"}
            onClick={() => void refresh()}
          >
            Refresh client view
          </button>
          <div aria-live="polite">
            {state.kind === "loading" && <p>Loading client view…</p>}
            {state.kind === "saving" && <p>Saving your choice…</p>}
            {state.kind === "closed" && <p>Session changed. Reopen the deal to continue.</p>}
            {state.kind === "refused" && <p role="alert">{state.message}</p>}
            {state.kind === "unavailable" && <p role="alert">Client view unavailable. Refresh to try again.</p>}
            {state.kind === "uncertain" && (
              <p role="alert">
                Your change was not confirmed. Refresh to check the current view or{" "}
                <button
                  type="button"
                  className="btn"
                  data-retry
                  onClick={() => {
                    if (state.kind === "uncertain") void save(state.command);
                  }}
                >
                  Retry the same action
                </button>
                .
              </p>
            )}
          </div>
          {state.kind === "ready" && (
            <>
              <section className="client-preview" data-client-preview aria-label="Published client preview">
                <h3>What the client sees</h3>
                {state.data.portal ? (
                  <>
                    <p>Portal · {state.data.portal.slug}</p>
                    {items([...state.data.portal.materials, ...state.data.portal.publications])}
                    {!state.data.portal.materials.length && !state.data.portal.publications.length && (
                      <p>No published items yet.</p>
                    )}
                  </>
                ) : (
                  <p>No active client portal for this deal. Publishing is unavailable.</p>
                )}
              </section>
              <section aria-label="Partner publication controls">
                <h3>Choose what to publish</h3>
                <p>
                  These controls are visible only to partners. Shared files appear in the preview only while CARR allows
                  them.
                </p>
                {state.data.rows.map((row) => (
                  <article className="client-publication-item" key={row.id}>
                    <h4>{row.title}</h4>
                    <p>
                      {row.kind} ·{" "}
                      {row.published ? "Marked published. Check preview for current visibility." : "Hidden draft"}
                    </p>
                    {row.kind !== "deliverable" && <p className="note-original">{row.content}</p>}
                    <button
                      type="button"
                      className="btn"
                      disabled={!canPublish}
                      {...(row.published ? { "data-unpublish": row.id } : { "data-publish": row.id })}
                      onClick={() => {
                        if (state.kind !== "ready") return;
                        const current =
                          row.kind === "deliverable" && !row.published
                            ? state.data.files.find((file) => file.id === row.deliverable_id)
                            : undefined;
                        const publication =
                          row.kind === "deliverable" && current
                            ? { ...row, deliverable_version: current.version }
                            : row;
                        void save(commandFor(publication, dealId, !row.published));
                      }}
                    >
                      {row.published ? "Unpublish" : "Publish"}
                    </button>
                  </article>
                ))}
                <section aria-label="Publish a finalized file">
                  <h4>Finalized files</h4>
                  <p>Refresh after changing a file in Documents. Publishing uses the exact version shown here.</p>
                  {state.data.files.map((file) => (
                    <article className="client-publication-item" key={file.id}>
                      <h4>{file.filename}</h4>
                      <p>
                        {file.visibility} · Version {file.version}
                      </p>
                      <button
                        type="button"
                        className="btn"
                        disabled={!canPublish || file.visibility !== "shared"}
                        data-publish-file={file.id}
                        onClick={() => {
                          if (state.kind !== "ready") return;
                          const previous = state.data.rows.find(
                            (row) => row.kind === "deliverable" && row.deliverable_id === file.id,
                          );
                          void save({
                            deal_id: dealId,
                            publication_id: previous?.id ?? crypto.randomUUID(),
                            base_version: previous?.version ?? 0,
                            title: titleForFile(file.filename),
                            published: true,
                            kind: "deliverable",
                            deliverable_id: file.id,
                            deliverable_version: file.version,
                            idempotency_key: crypto.randomUUID(),
                          });
                        }}
                      >
                        Publish {file.filename}
                      </button>
                    </article>
                  ))}
                  {!state.data.files.length && <p>No finalized files. Upload a file in Documents first.</p>}
                </section>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (state.kind !== "ready" || !state.data.portal) return;
                    const form = event.currentTarget,
                      data = new FormData(form);
                    const title = data.get("title"),
                      content = data.get("content"),
                      kind = data.get("kind");
                    if (
                      typeof title !== "string" ||
                      typeof content !== "string" ||
                      !title.trim() ||
                      !content.trim() ||
                      (kind !== "milestone" && kind !== "document" && kind !== "report" && kind !== "tour")
                    )
                      return;
                    void save({
                      deal_id: dealId,
                      publication_id: crypto.randomUUID(),
                      base_version: 0,
                      published: false,
                      kind,
                      title: title.trim(),
                      content: content.trim(),
                      idempotency_key: crypto.randomUUID(),
                    });
                  }}
                >
                  <h4>Add a hidden draft</h4>
                  <label>
                    Item type
                    <select name="kind">
                      <option value="milestone">Milestone</option>
                      <option value="document">Document</option>
                      <option value="report">Report</option>
                      <option value="tour">Tour summary</option>
                    </select>
                  </label>
                  <label>
                    Title
                    <input name="title" required maxLength={200} />
                  </label>
                  <label>
                    Client text
                    <textarea name="content" required maxLength={10000} />
                  </label>
                  <button type="submit" className="btn" disabled={!canPublish}>
                    Save hidden draft
                  </button>
                </form>
              </section>
            </>
          )}
        </section>,
      ),
    );
  }
  async function refresh() {
    if (disposed || state.kind === "saving" || state.kind === "closed" || (state.kind === "loading" && generation > 0))
      return;
    const ticket = ++generation;
    controller.abort();
    controller = new AbortController();
    state = { kind: "loading" };
    render();
    try {
      const options = { signal: controller.signal };
      const [list, preview, files] = await Promise.all([
        request("list-deal-client-publications", { deal_id: dealId }, options),
        request("preview-deal-client-view", { deal_id: dealId }, options),
        request("list-deal-deliverables", { deal_id: dealId }, options),
      ]);
      if (disposed || ticket !== generation) return;
      state = {
        kind: "ready",
        data: {
          rows: parsePublications(list),
          portal: parsePortal(preview),
          files: parseDeliverableList(files, dealId),
        },
      };
    } catch {
      if (disposed || ticket !== generation) return;
      state = { kind: "unavailable" };
    }
    render();
  }
  async function save(command: Command) {
    if (disposed || (state.kind !== "ready" && state.kind !== "uncertain")) return;
    const ticket = ++generation;
    state = { kind: "saving" };
    render();
    try {
      const response = await request("set-client-publication", command, { signal: controller.signal });
      if (disposed || ticket !== generation) return;
      const refusal = publicationFailure(response);
      if (refusal) {
        state = { kind: "refused", message: refusal };
        render();
        return;
      }
      const result = envelope(response);
      const receipt = result.publication;
      if (
        !receipt ||
        typeof receipt !== "object" ||
        !("id" in receipt) ||
        receipt.id !== command.publication_id ||
        !("version" in receipt) ||
        receipt.version !== command.base_version + 1 ||
        !("published" in receipt) ||
        receipt.published !== command.published
      )
        throw Error("Unconfirmed write");
      if (disposed || ticket !== generation) return;
      state = { kind: "unavailable" };
      await refresh();
    } catch {
      if (disposed || ticket !== generation) return;
      state = { kind: "uncertain", command };
      render();
    }
  }
  void refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      ++generation;
      controller.abort();
      view?.removeEventListener("doctorcre-session-invalidated", invalidate);
      root.unmount();
    },
  };
}
