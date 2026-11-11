import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { type NeedsQuery, parseClientNeeds } from "./vendor-client-needs-client.ts";

type State =
  | { kind: "reading" | "unavailable" | "refused" }
  | { kind: "ready"; page: ReturnType<typeof parseClientNeeds> };
type Load = (query: NeedsQuery, signal: AbortSignal) => Promise<unknown>;
function ClientNeeds({ vendor, load }: { vendor: string; load: Load }) {
  const [query, setQuery] = useState<NeedsQuery>({ vendor, offset: 0, limit: 5 });
  const [state, setState] = useState<State>({ kind: "reading" });
  useEffect(() => {
    const controller = new AbortController();
    void load(query, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setState({ kind: "ready", page: parseClientNeeds(result, query) });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({ kind: error instanceof Error && error.name === "NeedsRefused" ? "refused" : "unavailable" });
      });
    return () => controller.abort();
  }, [query, load]);
  function read(offset = 0) {
    setState({ kind: "reading" });
    setQuery({ vendor, offset, limit: 5 });
  }
  return (
    <section
      className="record-section client-needs"
      aria-label="Approved client needs"
      aria-busy={state.kind === "reading"}
    >
      <h3>Approved client needs</h3>
      <p className="note-summary">Recorded needs for this vendor, approved on the client’s deal.</p>
      {state.kind === "reading" && <p role="status">Reading client needs…</p>}
      {state.kind === "unavailable" && <p role="alert">Client needs unavailable. The source could not be verified.</p>}
      {state.kind === "refused" && (
        <p role="alert">Permission refused. Client needs are not available to this session.</p>
      )}
      {state.kind === "ready" && (
        <>
          {state.page.state === "missing_approval" && (
            <p role="status">Approval needed. No approved client needs can be shown.</p>
          )}
          {state.page.state === "empty" && <p role="status">No approved client needs match this vendor.</p>}
          <ul className="client-needs-list">
            {state.page.rows.map((row) => (
              <li key={row.id} data-need-id={row.id}>
                <h4>{row.client_name}</h4>
                <p>{row.description}</p>
                <dl>
                  <div className="record-field">
                    <dt>Deal</dt>
                    <dd>{row.deal_name}</dd>
                  </div>
                  <div className="record-field">
                    <dt>Why it matches</dt>
                    <dd>{row.applicability}</dd>
                  </div>
                  <div className="record-field">
                    <dt>Source</dt>
                    <dd>{row.source_ref}</dd>
                  </div>
                  <div className="record-field">
                    <dt>Source version</dt>
                    <dd>{row.source_revision}</dd>
                  </div>
                  <div className="record-field">
                    <dt>Approval</dt>
                    <dd>Approved · revision {row.approved_revision}</dd>
                  </div>
                  <div className="record-field">
                    <dt>Approved at</dt>
                    <dd>{row.approved_at}</dd>
                  </div>
                  <div className="record-field">
                    <dt>Fresh until</dt>
                    <dd>{row.fresh_until}</dd>
                  </div>
                </dl>
                <details>
                  <summary>Need identity</summary>
                  <dl>
                    {Object.entries({
                      Need: row.id,
                      Client: row.client_id,
                      Deal: row.deal_id,
                      Vendor: row.vendor_id,
                      "Approved by": row.approved_by,
                    }).map(([label, value]) => (
                      <div className="record-field" key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
          {state.page.next_offset !== null && (
            <button
              type="button"
              className="action"
              onClick={() => {
                if (state.page.next_offset !== null) read(state.page.next_offset);
              }}
            >
              Next needs
            </button>
          )}
        </>
      )}
      <button
        type="button"
        className="action secondary-action"
        disabled={state.kind === "reading"}
        onClick={() => read()}
      >
        {state.kind === "unavailable" || state.kind === "refused" ? "Retry client needs" : "Refresh client needs"}
      </button>
    </section>
  );
}
export function mountVendorClientNeeds(host: HTMLElement, vendor: string, load: Load) {
  const root = createRoot(host);
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("doctorcre-session-invalidated", dispose);
    flushSync(() => root.unmount());
  }
  window.addEventListener("doctorcre-session-invalidated", dispose);
  flushSync(() => root.render(<ClientNeeds vendor={vendor} load={load} />));
  return { dispose };
}
