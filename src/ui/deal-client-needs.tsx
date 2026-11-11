import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Fields, Need } from "./deal-client-needs-model.ts";
import { approvable, createNeedAuthor } from "./deal-client-needs-model.ts";
import { parseVendorMarkets, type VendorMarkets } from "./vendor-markets-client.ts";

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
function localDate(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
function validateDates(form: HTMLFormElement) {
  const observed = form.elements.namedItem("observed_at");
  const fresh = form.elements.namedItem("fresh_until");
  if (!(observed instanceof HTMLInputElement) || !(fresh instanceof HTMLInputElement)) return false;
  fresh.setCustomValidity(
    Number.isFinite(Date.parse(observed.value)) && Date.parse(fresh.value) > Date.parse(observed.value)
      ? ""
      : "Fresh until must follow the observation.",
  );
  return fresh.validity.valid;
}
type Directory = { kind: "loading" } | { kind: "unavailable" } | { kind: "ready"; page: VendorMarkets };
function VendorPicker({ directory, need }: { directory: Directory; need: Need | null }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(need?.vendor_id ?? "");
  const vendors = directory.kind === "ready" ? directory.page.vendors : [];
  const matches = vendors.filter(
    (v) => v.id === selected || v.name?.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <fieldset>
      <legend>Vendor</legend>
      <label>
        Search vendors by name
        <input type="search" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      </label>
      <label>
        Choose vendor
        <select name="vendor" required value={selected} onChange={(e) => setSelected(e.currentTarget.value)}>
          <option value="">Select a vendor</option>
          {need && !vendors.some((v) => v.id === need.vendor_id) && (
            <option value={need.vendor_id}>{need.vendor_ref} · Current vendor</option>
          )}
          {matches.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name || v.ref} ·{" "}
              {v.market_slugs
                .map((slug) =>
                  directory.kind === "ready"
                    ? (directory.page.markets.find((m) => m.slug === slug)?.name ?? slug)
                    : slug,
                )
                .join(", ") || "Market not recorded"}
            </option>
          ))}
        </select>
      </label>
      {directory.kind === "ready" && selected && (
        <p className="need-vendor-selection">
          {vendors.find((v) => v.id === selected)?.name ?? need?.vendor_ref} ·{" "}
          {vendors
            .find((v) => v.id === selected)
            ?.market_slugs.map((slug) => directory.page.markets.find((m) => m.slug === slug)?.name ?? slug)
            .join(", ") || "Market not recorded"}
        </p>
      )}
      {directory.kind !== "ready" && (
        <p role="status">
          {directory.kind === "loading"
            ? "Reading vendors…"
            : "Vendor directory unavailable. Reopen the deal to try again."}
        </p>
      )}
      {directory.kind === "ready" && !matches.length && <p>No vendors match this name.</p>}
    </fieldset>
  );
}
function Evidence({ need: n, vendor }: { need: Need; vendor: string }) {
  const rows = (values: Record<string, string>) =>
    Object.entries(values).map(([label, value]) => (
      <div key={label}>
        <dt>{label}</dt>
        <dd data-need-field={label}>{value}</dd>
      </div>
    ));
  return (
    <>
      <dl>
        {rows({
          "Vendor name": vendor,
          Applicability: n.applicability,
          Source: n.source_ref,
          "Source revision": n.source_revision,
          Restriction: n.restriction,
          Observed: new Date(n.observed_at).toLocaleString(),
          "Fresh through": new Date(n.fresh_until).toLocaleString(),
        })}
      </dl>
      <details>
        <summary>Exact identities and approval details</summary>
        <dl>
          {rows({
            Client: `${n.client_name} (${n.client_id})`,
            Deal: `${n.deal_name} (${n.deal_id})`,
            Vendor: `${n.vendor_ref} (${n.vendor_id})`,
            Need: n.id,
            Revision: String(n.revision),
            "Record version": String(n.version),
            "Approval revision": n.approved_revision === null ? "Not approved" : String(n.approved_revision),
            "Approved by": n.approved_by ?? "Not recorded",
            "Approved at": n.approved_at ?? "Not recorded",
            "Observed at": n.observed_at,
            "Fresh until": n.fresh_until,
          })}
        </dl>
      </details>
    </>
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
  let directory: Directory = { kind: "loading" };
  let disposed = false;
  const vendorName = (n: Need) =>
    directory.kind === "ready"
      ? directory.page.vendors.find((v) => v.id === n.vendor_id)?.name || n.vendor_ref
      : n.vendor_ref;
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
              onInput={(event) => {
                validateDates(event.currentTarget);
              }}
              onSubmit={(event) => {
                event.preventDefault();
                if (!validateDates(event.currentTarget)) {
                  event.currentTarget.reportValidity();
                  return;
                }
                const data = new FormData(event.currentTarget);
                const value = (name: string) => String(data.get(name) ?? "");
                const fields: Fields = {
                  vendor: value("vendor"),
                  description: value("description"),
                  applicability: value("applicability"),
                  source_ref: value("source_ref"),
                  source_revision: value("source_revision"),
                  observed_at: new Date(value("observed_at")).toISOString(),
                  fresh_until: new Date(value("fresh_until")).toISOString(),
                  restriction: data.get("restriction") === "restricted" ? "restricted" : "allowed",
                  withdrawn: false,
                };
                void model.save(fields);
              }}
            >
              <h3>{state.need ? "Edit client need" : "Record client need"}</h3>
              <p>Saving an edit lapses approval. Review the saved revision before approving it.</p>
              <VendorPicker directory={directory} need={state.need} />
              {(["description", "applicability", "source_ref"] as const).map((name) => (
                <label key={name}>
                  {
                    { description: "Need description", applicability: "Applicability", source_ref: "Source identity" }[
                      name
                    ]
                  }
                  <textarea
                    name={name}
                    required
                    rows={3}
                    maxLength={2000}
                    defaultValue={state.need?.[name] ?? ""}
                    ref={(element) => {
                      if (element) {
                        element.style.height = "auto";
                        element.style.height = `${element.scrollHeight}px`;
                      }
                    }}
                    onInput={(event) => {
                      event.currentTarget.style.height = "auto";
                      event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
                    }}
                  />
                </label>
              ))}
              <label>
                Source revision
                <input
                  name="source_revision"
                  required
                  maxLength={200}
                  defaultValue={state.need?.source_revision ?? ""}
                />
              </label>
              <p>Dates use your local time. New needs stay fresh for 30 days.</p>
              <div className="need-dates">
                <label>
                  Observed at
                  <input
                    name="observed_at"
                    type="datetime-local"
                    step="1"
                    required
                    defaultValue={localDate(state.need?.observed_at ?? new Date().toISOString())}
                  />
                </label>
                <label>
                  Fresh until
                  <input
                    name="fresh_until"
                    type="datetime-local"
                    step="1"
                    required
                    defaultValue={localDate(
                      state.need?.fresh_until ?? new Date(Date.now() + 30 * 86400000).toISOString(),
                    )}
                  />
                </label>
              </div>
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
              <Evidence need={state.need} vendor={vendorName(state.need)} />
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
                  <Evidence need={n} vendor={vendorName(n)} />
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
  void options
    .call("read-vendor-markets-v1", {})
    .then((value) => {
      if (disposed || model.state.kind === "retired") return;
      directory = { kind: "ready", page: parseVendorMarkets(value) };
      render();
    })
    .catch(() => {
      if (disposed || model.state.kind === "retired") return;
      directory = { kind: "unavailable" };
      render();
    });
  void model.load();
  return {
    dispose() {
      disposed = true;
      listeners.delete(render);
      root.unmount();
    },
  };
}
