import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { mountLocalTicker } from "../../js/visibility-poll.mjs";
import { type Criteria, SavedSearches, type SearchCall } from "./deal-space-search-model.ts";

export function mountSavedSearches(
  element: Element,
  options: {
    dealId: string;
    call: SearchCall;
    describe(id: string): string | null;
    hydrate(ids: string[]): Promise<void>;
    handoff(ids: string[]): boolean;
  },
) {
  const root = createRoot(element);
  let disposed = false;
  let hydratedVersion = "";
  let clock: ReturnType<typeof mountLocalTicker> | undefined;
  const model = new SavedSearches(options.dealId, options.call, render, async (id) => {
    const path = "/tours/planner-client.js";
    const module: { createPlannerClient(): { client(id: string): Promise<unknown> } } = await import(path);
    return module.createPlannerClient().client(id);
  });
  function update(field: string, value: string | number | boolean | string[] | null, criteria = false) {
    if (!model.draft) return;
    model.update(
      criteria
        ? { ...model.draft, criteria: { ...model.draft.criteria, [field]: value } }
        : { ...model.draft, [field]: value },
    );
  }
  function number(field: "min_square_feet" | "max_square_feet", label: string) {
    return (
      <label>
        {label}
        <input
          type="number"
          min="0"
          max="100000000"
          value={model.draft?.criteria[field] ?? ""}
          onChange={(event) => update(field, event.target.value === "" ? null : Number(event.target.value), true)}
        />
      </label>
    );
  }
  function choice(field: keyof Criteria, label: string) {
    const value = model.draft?.criteria[field];
    return (
      <label>
        {label}
        <select
          value={value === null ? "" : String(value)}
          onChange={(event) => update(field, event.target.value === "" ? null : event.target.value === "true", true)}
        >
          <option value="">Any</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </label>
    );
  }
  function sourceReview() {
    const review = model.sourceReview;
    return (
      <section
        aria-label="Client context review"
        style={{ overflowWrap: "anywhere", border: "1px solid var(--border)", padding: 12, borderRadius: 8 }}
      >
        <h4>Start from this deal's client</h4>
        <p>Review client context before using it. Refresh keeps your edits until you choose otherwise.</p>
        <button
          type="button"
          disabled={model.working || review.kind === "reading"}
          onClick={() => void model.reviewClient()}
        >
          {review.kind === "reading" ? "Reading client…" : "Review or refresh client context"}
        </button>
        {review.kind === "failed" && <p role="status">Client read failed. Your edits remain. Retry the review.</p>}
        {review.kind === "changed" && (
          <p role="status">The deal's client changed. Review its current client before using context.</p>
        )}
        {review.kind === "applied" && <p role="status">Reviewed choices applied to this draft.</p>}
        {review.kind === "review" && (
          <>
            <p>Client {review.source.client_id}</p>
            <p>
              Source <a href={review.source.source_ref}>{review.source.source_ref}</a>
            </p>
            <p>
              Read observed{" "}
              <time dateTime={review.source.observed_at}>
                {new Date(review.source.observed_at).toLocaleString("en-US", { timeZone: "America/Chicago" })} Central
              </time>
              . This is the read time, not an evidence date.
            </p>
            <p>Location context · {review.source.location || "Unknown"}. This is not a search preference.</p>
            <p>Use context · {review.source.use || "Unknown"}. Size and budget remain unspecified.</p>
            {(["name", "requirements"] as const).map((field) => (
              <fieldset key={field}>
                <legend>{field === "name" ? "Search name" : "Descriptive requirements"} review</legend>
                <p>Current draft · {model.draft?.[field] || "Empty"}</p>
                <p style={{ whiteSpace: "pre-wrap" }}>Client source · {review.source[field] || "Empty"}</p>
                <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44 }}>
                  <input
                    style={{ width: 20, height: 20, margin: 0 }}
                    type="radio"
                    name={`source-${field}`}
                    checked={review.choices[field] === "keep"}
                    onChange={() => model.chooseSource(field, "keep")}
                  />
                  Keep my {field}
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44 }}>
                  <input
                    style={{ width: 20, height: 20, margin: 0 }}
                    type="radio"
                    name={`source-${field}`}
                    checked={review.choices[field] === "use"}
                    onChange={() => model.chooseSource(field, "use")}
                  />
                  Use client {field}
                </label>
              </fieldset>
            ))}
            <button
              type="button"
              disabled={!review.choices.name || !review.choices.requirements || model.working}
              onClick={() => void model.applySource()}
            >
              Apply reviewed choices
            </button>
          </>
        )}
      </section>
    );
  }
  function render() {
    if (disposed) return;
    clock?.dispose();
    clock = undefined;
    const row = model.current;
    if (row?.last_run_at && row.status === "saved" && !model.stale() && model.phase !== "retired") {
      const remaining = Math.min(2147483647, Date.parse(row.last_run_at) + 86400000 - Date.now());
      clock = mountLocalTicker({
        tick: () => {
          model.age();
          render();
        },
        intervalMs: remaining,
        maxTicks: 1,
        idleMs: Infinity,
      });
    }
    const draft = model.draft;
    const locked = model.working || model.phase === "retired";
    flushSync(() =>
      root.render(
        <section className="saved-space-searches" aria-label="Saved space searches" data-phase={model.phase}>
          <h3>Saved space searches</h3>
          <p>
            Keep the search brief with this deal. Rerun reviewed CARR properties and choose candidates for your Tour.
          </p>
          <div className="search-actions">
            <button type="button" disabled={locked || model.dirty} onClick={() => model.edit()}>
              New space search
            </button>
            <button type="button" disabled={locked || model.dirty} onClick={() => void model.load()}>
              Reload saved searches
            </button>
          </div>
          <p role="status">{model.message}</p>
          <ul className="saved-search-list">
            {model.rows.map((search) => (
              <li key={search.id}>
                <button
                  type="button"
                  disabled={locked || model.dirty}
                  data-search-id={search.id}
                  onClick={() => model.edit(search)}
                >
                  {search.name}
                </button>
                <span>
                  {search.status === "archived" ? "Archived" : search.state === "stale" ? "Results stale" : "Saved"} ·
                  version {search.version}
                </span>
              </li>
            ))}
          </ul>
          {draft && (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void model.write("save");
                }}
              >
                <fieldset disabled={locked || row?.status === "archived"}>
                  <legend>{row ? "Search brief" : "New search brief"}</legend>
                  {sourceReview()}
                  <label>
                    Search name
                    <input
                      required
                      maxLength={240}
                      value={draft.name}
                      onChange={(event) => update("name", event.target.value)}
                    />
                  </label>
                  <details open={row === null ? true : undefined}>
                    <summary>
                      Search filters · {draft.criteria.counties.join(", ") || "All five counties"} ·{" "}
                      {draft.criteria.min_square_feet ?? "Any"} to {draft.criteria.max_square_feet ?? "any"} SF
                    </summary>
                    <label>
                      Name or address
                      <input
                        maxLength={200}
                        value={draft.criteria.query ?? ""}
                        onChange={(event) => update("query", event.target.value || null, true)}
                      />
                    </label>
                    <div className="filter-grid">
                      <label>
                        Counties
                        <select
                          multiple
                          size={5}
                          value={draft.criteria.counties}
                          onChange={(event) =>
                            update(
                              "counties",
                              Array.from(event.target.selectedOptions, (option) => option.value),
                              true,
                            )
                          }
                        >
                          {["Escambia", "Santa Rosa", "Okaloosa", "Walton", "Bay"].map((county) => (
                            <option key={county}>{county}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Property types, separated by commas
                        <input
                          value={draft.criteria.property_types.join(",")}
                          onChange={(event) => update("property_types", event.target.value.split(","), true)}
                        />
                      </label>
                      {number("min_square_feet", "Minimum square feet")}
                      {number("max_square_feet", "Maximum square feet")}
                      <label>
                        Availability
                        <select
                          multiple
                          value={draft.criteria.availability}
                          onChange={(event) =>
                            update(
                              "availability",
                              Array.from(event.target.selectedOptions, (option) => option.value),
                              true,
                            )
                          }
                        >
                          {["available", "coming_soon", "under_contract", "unknown"].map((value) => (
                            <option key={value} value={value}>
                              {value.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Sort
                        <select
                          value={draft.criteria.sort}
                          onChange={(event) => update("sort", event.target.value, true)}
                        >
                          {[
                            ["updated_desc", "Recently updated"],
                            ["address_asc", "Address A–Z"],
                            ["size_asc", "Smallest first"],
                            ["size_desc", "Largest first"],
                          ].map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {choice("entrance_verified", "Verified entrance")}
                      {choice("photos_available", "Photos available")}
                      {choice("public_projection_ready", "Ready for client projection")}
                      <label>
                        Results per run
                        <input
                          type="number"
                          min="1"
                          max="100"
                          required
                          value={draft.criteria.limit}
                          onChange={(event) => update("limit", Number(event.target.value), true)}
                        />
                      </label>
                    </div>
                  </details>
                  <label>
                    Budget, timing and other requirements
                    <textarea
                      maxLength={8000}
                      rows={4}
                      value={draft.requirements}
                      onChange={(event) => update("requirements", event.target.value)}
                    />
                  </label>
                  <p>
                    Requirements stay in the brief. Budget, timing and other written requirements do not filter these
                    results.
                  </p>
                  {draft.client_prefill_source && (
                    <p>
                      Client prefill source · {draft.client_prefill_source.source_ref} · client{" "}
                      {draft.client_prefill_source.client_id} · observed {draft.client_prefill_source.observed_at}
                    </p>
                  )}
                  <button type="submit" disabled={!model.dirty && row?.status === "saved"}>
                    Save search
                  </button>
                </fieldset>
              </form>
              {model.phase === "version-conflict" && row && (
                <section aria-label="Newer saved search">
                  <h4>Newer saved search · version {row.version}</h4>
                  <p>{row.name}</p>
                  <pre>{JSON.stringify(row.criteria, null, 2)}</pre>
                  <p>{row.requirements}</p>
                </section>
              )}
              <div className="search-actions">
                <button
                  type="button"
                  disabled={locked || !row || model.dirty || row.status !== "saved"}
                  onClick={() => void model.write("run")}
                >
                  Rerun saved search
                </button>
                {row && (
                  <button
                    type="button"
                    disabled={locked || model.dirty}
                    onClick={() => void model.write(row.status === "archived" ? "restore" : "archive")}
                  >
                    {row.status === "archived" ? "Restore search" : "Archive search"}
                  </button>
                )}
                <button type="button" disabled={locked} onClick={() => model.cancel()}>
                  Cancel search
                </button>
              </div>
              {row?.last_run_at && (
                <section aria-label="Saved search results">
                  <h4>{model.stale() ? "Stale results · rerun before using" : "Saved results"}</h4>
                  <p>
                    Last run{" "}
                    <time dateTime={row.last_run_at}>
                      {new Date(row.last_run_at).toLocaleString("en-US", { timeZone: "America/Chicago" })} Central
                    </time>{" "}
                    · {row.result_property_ids.length}{" "}
                    {row.result_property_ids.length === 1 ? "property" : "properties"}
                  </p>
                  {row.has_more && (
                    <p>This is the first {row.criteria.limit} results. Narrow your criteria to review more.</p>
                  )}
                  {row.run_criteria && model.stale() && (
                    <details>
                      <summary>Criteria used for these results</summary>
                      <pre>{JSON.stringify(row.run_criteria, null, 2)}</pre>
                    </details>
                  )}
                  <ul>
                    {row.result_property_ids.map((id, index) => (
                      <li key={id} data-result-property-id={id}>
                        <label title={id}>
                          <input
                            type="checkbox"
                            checked={model.selected.has(id)}
                            disabled={locked || model.stale() || row.status !== "saved"}
                            onChange={() => model.toggle(id)}
                          />
                          {options.describe(id) ?? `Property ${index + 1} · details unavailable`}
                          {model.newIds.has(id) && <strong> · New since previous run</strong>}
                        </label>
                      </li>
                    ))}
                  </ul>
                  {!row.result_property_ids.length && <p>No properties matched the saved criteria.</p>}
                  <button
                    type="button"
                    disabled={locked || model.stale() || !model.selected.size || row.status !== "saved"}
                    onClick={() => model.handoff(options.handoff)}
                  >
                    Add chosen results to Tour cart
                  </button>
                  <p>
                    Open or create a Tour first. The cart keeps existing choices; save its selection before adding route
                    stops.
                  </p>
                </section>
              )}
            </>
          )}
        </section>,
      ),
    );
    const version = row ? `${row.id}:${row.version}` : "";
    if (version && version !== hydratedVersion) {
      hydratedVersion = version;
      void options
        .hydrate(row?.result_property_ids ?? [])
        .then(() => {
          if (!disposed) render();
        })
        .catch(() => {});
    }
  }
  render();
  void model.load();
  return {
    refresh: render,
    dirty: () => model.blocksDeparture,
    retire: () => {
      clock?.dispose();
      model.retire();
    },
    dispose: () => {
      disposed = true;
      clock?.dispose();
      model.retire();
      root.unmount();
    },
  };
}
