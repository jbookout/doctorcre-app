import { createDealUpdateSummary, type SummaryRead, type UpdateEntry } from "./deal-update-summary-model";
export function mountDealUpdateSummary(
  root: HTMLElement,
  {
    dealId,
    read,
    renderHistory,
    onDenied,
    historyChanged,
  }: {
    dealId: string;
    read: SummaryRead;
    renderHistory: (entries: UpdateEntry[]) => string;
    onDenied: (error: unknown) => void;
    historyChanged: () => void;
  },
) {
  root.innerHTML =
    '<section class="deal-updates" aria-label="Deal updates"><h3>Updates</h3><p data-summary role="status"></p><p class="updates-scope" data-coverage></p><details class="updates-history"><summary data-detail-focus="update-history">Show update history</summary><p data-newest></p><div data-history></div><p data-history-status role="status"></p><button class="btn" type="button" data-older>Load older updates</button></details><button class="btn" type="button" data-summary-retry hidden>Retry summary</button></section>';
  const find = <T extends Element>(selector: string, ctor: { new (...args: never[]): T }): T => {
    const node = root.querySelector(selector);
    if (!(node instanceof ctor)) throw Error("Update mount missing");
    return node;
  };
  const summary = find("[data-summary]", HTMLParagraphElement),
    coverage = find("[data-coverage]", HTMLParagraphElement),
    details = find("details", HTMLDetailsElement),
    trigger = find("summary", HTMLElement),
    history = find("[data-history]", HTMLDivElement),
    status = find("[data-history-status]", HTMLParagraphElement),
    older = find("[data-older]", HTMLButtonElement),
    retry = find("[data-summary-retry]", HTMLButtonElement),
    newest = find("[data-newest]", HTMLParagraphElement);
  let prior = "";
  let savedOpens = new Set<string | null | undefined>();
  let savedFocus: string | null | undefined;
  const model = createDealUpdateSummary({
    dealId,
    read,
    onDenied,
    changed() {
      const s = model.state();
      summary.textContent = s.retired
        ? "Sign in to read deal updates."
        : s.summary.kind === "ready"
          ? s.summary.value.summary.text
          : s.summary.kind === "error"
            ? "Deal summary unavailable."
            : "Loading deal summary…";
      root.dataset.sourceRevision = s.summary.kind === "ready" ? s.summary.value.source_revision : "";
      coverage.textContent =
        s.summary.kind === "ready"
          ? (s.summary.value.coverage.complete
              ? "Summary covers all recorded supported updates."
              : `Partial summary · ${s.summary.value.coverage.covered_count} source statements quoted. Older updates or longer text may be omitted.`) +
            (s.summary.value.coverage.unsupported_events_present
              ? " History covers notes, activities and supported deal changes only; other event fields are not included."
              : " History covers notes, activities and supported deal changes.")
          : "";
      coverage.hidden = !coverage.textContent;
      retry.hidden = s.summary.kind !== "error";
      details.hidden = s.retired;
      details.open = s.expanded;
      const html = renderHistory(s.rows);
      if (html !== prior) {
        const opens = new Set(
          [...history.querySelectorAll("details[open]")].map((e) =>
            e.querySelector("summary")?.getAttribute("data-detail-focus"),
          ),
        );
        const focused = history.contains(document.activeElement)
          ? document.activeElement?.getAttribute("data-detail-focus")
          : null;
        if (history.childElementCount) savedOpens = opens;
        if (focused) savedFocus = focused;
        history.innerHTML = html;
        prior = html;
        if (!s.retired) historyChanged();
        for (const el of history.querySelectorAll("details")) {
          if (savedOpens.has(el.querySelector("summary")?.getAttribute("data-detail-focus"))) el.open = true;
        }
        if (savedFocus && s.history.kind === "ready") {
          const target = [...history.querySelectorAll<HTMLElement>("[data-detail-focus]")].find(
            (e) => e.dataset.detailFocus === savedFocus,
          );
          if (document.activeElement === document.body || history.contains(document.activeElement))
            (target ?? trigger).focus({ preventScroll: true });
          savedFocus = null;
        }
      }
      const latest = s.rows[0];
      newest.textContent = latest
        ? `Newest recorded update · ${new Date(latest.at).toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" })}`
        : "";
      status.textContent =
        s.history.kind === "loading"
          ? "Loading update history…"
          : s.history.kind === "error"
            ? s.rows.length
              ? "Older updates unavailable. Loaded updates remain below."
              : "Update history unavailable."
            : s.history.kind === "ready"
              ? s.cursor
                ? "More updates are available."
                : s.rows.length
                  ? "End of supported update history."
                  : "No supported updates recorded."
              : "";
      older.hidden = !(s.history.kind === "error" || s.cursor);
      if (older.hidden && document.activeElement === older) trigger.focus({ preventScroll: true });
      older.disabled = s.history.kind === "loading";
      older.textContent = s.history.kind === "error" ? "Retry history" : "Load older updates";
    },
  });
  const toggle = () => {
    if (details.open !== model.state().expanded) {
      if (details.open) void model.expand();
      else {
        model.collapse();
        trigger.focus({ preventScroll: true });
      }
    }
  };
  details.addEventListener("toggle", toggle);
  older.onclick = () => void model.more();
  retry.onclick = () => void refresh();
  const retire = () => model.dispose();
  window.addEventListener("doctorcre-session-invalidated", retire);
  void model.refresh();
  function refresh() {
    if (model.state().retired) return Promise.resolve();
    historyChanged();
    return model.refresh();
  }
  return {
    refresh,
    dispose() {
      window.removeEventListener("doctorcre-session-invalidated", retire);
      details.removeEventListener("toggle", toggle);
      model.dispose();
      root.replaceChildren();
    },
  };
}
