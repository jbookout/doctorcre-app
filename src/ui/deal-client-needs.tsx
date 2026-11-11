import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Fields, Need } from "./deal-client-needs-model.ts";
import { approvable, createNeedAuthor, fieldsOf } from "./deal-client-needs-model.ts";

type Options = Parameters<typeof createNeedAuthor>[0];
const sessions = new Map<string, { model: ReturnType<typeof createNeedAuthor>; listeners: Set<() => void> }>();
if (typeof window !== "undefined")
  window.addEventListener("doctorcre-session-invalidated", () => {
    for (const s of sessions.values()) s.model.retire();
    sessions.clear();
  });
const labels = {
  draft: "Draft",
  approved: "Approved",
  edited_lapsed: "Approval lapsed",
  withdrawn: "Withdrawn",
  stale: "Stale",
};
function Evidence({ need: n }: { need: Need }) {
  return (
    <dl>
      {Object.entries({
        Client: `${n.client_name} (${n.client_id})`,
        Deal: `${n.deal_name} (${n.deal_id})`,
        Vendor: `${n.vendor_ref} (${n.vendor_id})`,
        Need: n.id,
        Revision: String(n.revision),
        "Record version": String(n.version),
        "Approval revision": n.approved_revision === null ? "Not approved" : String(n.approved_revision),
        "Approved by": n.approved_by ?? "Not recorded",
        "Approved at": n.approved_at ?? "Not recorded",
        Applicability: n.applicability,
        Restriction: n.restriction,
        Source: n.source_ref,
        "Source revision": n.source_revision,
        "Observed at": n.observed_at,
        "Fresh until": n.fresh_until,
      }).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd data-need-field={label}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function mountDealClientNeeds(host: Element, options: Omit<Options, "changed">) {
  const key = `${options.deal}:${options.client}`;
  let session = sessions.get(key);
  if (!session) {
    const listeners = new Set<() => void>();
    session = {
      listeners,
      model: createNeedAuthor({
        ...options,
        changed() {
          for (const notify of listeners) notify();
        },
      }),
    };
    sessions.set(key, session);
  }
  const { model, listeners } = session;
  const root = createRoot(host);
  function render() {
    const state = model.state;
    const canList = state.kind === "listing";
    flushSync(() =>
      root.render(
        <section className="deal-client-needs" aria-label="Client needs">
          <h2>Client needs</h2>
          <p>
            Record a sourced need for an exact vendor. Approval makes it eligible for matching. No message or
            introduction is sent.
          </p>
          <p role="status">
            {state.kind === "loading"
              ? "Reading needs…"
              : state.kind === "pending"
                ? "Waiting for confirmation…"
                : state.kind === "unknown"
                  ? "Outcome unknown. This request key is retained. Check the same request before making another change."
                  : state.kind === "conflict"
                    ? "The need or its client changed, or the request was refused. Reload current needs before reviewing again."
                    : state.kind === "unavailable"
                      ? "Client needs unavailable."
                      : state.kind === "retired"
                        ? "Session ended. Sign in again."
                        : ""}
          </p>
          {["listing", "conflict", "unavailable"].includes(state.kind) && (
            <button type="button" className="btn" onClick={() => void model.load()}>
              Reload needs
            </button>
          )}
          {canList && (
            <button type="button" className="btn" onClick={() => model.edit()}>
              Record client need
            </button>
          )}
          {state.kind === "unknown" && (
            <>
              <p>
                Request key <code>{String(state.operation.args.idempotency_key)}</code>
              </p>
              <button type="button" className="btn" onClick={() => void model.check()}>
                Check same request
              </button>
            </>
          )}
          {state.kind === "editing" && (
            <form
              key={state.need?.id ?? "new"}
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const value = (name: string) => String(data.get(name) ?? "");
                const fields: Fields = {
                  vendor: value("vendor"),
                  description: value("description"),
                  applicability: value("applicability"),
                  source_ref: value("source_ref"),
                  source_revision: value("source_revision"),
                  observed_at: value("observed_at"),
                  fresh_until: value("fresh_until"),
                  restriction: data.get("restriction") === "restricted" ? "restricted" : "allowed",
                  withdrawn: false,
                };
                const freshness = event.currentTarget.elements.namedItem("fresh_until");
                if (freshness instanceof HTMLInputElement) {
                  freshness.setCustomValidity(
                    Number.isFinite(Date.parse(fields.observed_at)) &&
                      Number.isFinite(Date.parse(fields.fresh_until)) &&
                      Date.parse(fields.fresh_until) > Date.parse(fields.observed_at)
                      ? ""
                      : "Enter valid ISO dates. Fresh until must follow the observation.",
                  );
                  if (!freshness.reportValidity()) return;
                }
                void model.save(fields);
              }}
            >
              <h3>{state.need ? "Edit client need" : "Record client need"}</h3>
              <p>Saving an edit lapses approval. Review the saved revision before approving it.</p>
              {(
                [
                  "vendor",
                  "description",
                  "applicability",
                  "source_ref",
                  "source_revision",
                  "observed_at",
                  "fresh_until",
                ] as const
              ).map((name) => {
                const titles = {
                  vendor: "Vendor ID",
                  description: "Need description",
                  applicability: "Applicability",
                  source_ref: "Source identity",
                  source_revision: "Source revision",
                  observed_at: "Observed at (ISO date and time)",
                  fresh_until: "Fresh until (ISO date and time)",
                };
                return (
                  <label key={name}>
                    {titles[name]}
                    <input
                      name={name}
                      required
                      onChange={(event) => event.currentTarget.setCustomValidity("")}
                      maxLength={name === "source_revision" ? 200 : 2000}
                      pattern={name === "vendor" ? "[0-9a-fA-F-]{36}" : undefined}
                      defaultValue={state.need ? fieldsOf(state.need)[name] : ""}
                    />
                  </label>
                );
              })}
              <label>
                Restriction
                <select name="restriction" defaultValue={state.need?.restriction ?? "allowed"}>
                  <option value="allowed">Allowed</option>
                  <option value="restricted">Restricted</option>
                </select>
              </label>
              <button className="btn" type="submit">
                Save need
              </button>
              <button className="btn" type="button" onClick={() => model.cancel()}>
                Cancel
              </button>
            </form>
          )}
          {state.kind === "reviewing" && (
            <section aria-label="Review need revision">
              <h3>Review revision {state.need.revision}</h3>
              <p>{state.need.description}</p>
              <Evidence need={state.need} />
              <button className="btn" type="button" onClick={() => void model.approve()}>
                Approve this revision
              </button>
              <button className="btn" type="button" onClick={() => model.cancel()}>
                Cancel review
              </button>
            </section>
          )}
          {canList && (
            <>
              {!model.rows.length && <p>No client needs recorded.</p>}
              {model.rows.map((n) => (
                <article key={n.id} data-client-need={n.id}>
                  <h3>{n.description}</h3>
                  <p>
                    {labels[n.state]} · {n.restriction} · Fresh until {n.fresh_until}
                  </p>
                  <details>
                    <summary>Source and approval details</summary>
                    <Evidence need={n} />
                  </details>
                  <button className="btn" type="button" onClick={() => model.edit(n.id)}>
                    Edit need
                  </button>
                  {approvable(n) && n.state !== "approved" && (
                    <button className="btn" type="button" onClick={() => model.review(n.id)}>
                      Review for approval
                    </button>
                  )}
                  {n.state !== "withdrawn" && (
                    <button className="btn" type="button" onClick={() => void model.withdraw(n.id)}>
                      Withdraw need
                    </button>
                  )}
                </article>
              ))}
              {model.next !== null && (
                <button className="btn" type="button" onClick={() => void model.load(true)}>
                  More needs
                </button>
              )}
            </>
          )}
        </section>,
      ),
    );
  }
  listeners.add(render);
  render();
  void model.load();
  return {
    dispose() {
      listeners.delete(render);
      root.unmount();
    },
  };
}
