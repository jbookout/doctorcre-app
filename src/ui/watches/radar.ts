import { createWatchListReader } from "./client.ts";
import { isWatchSubjectId, type Watch } from "./model.ts";
import { watchSummary } from "./radar-model.ts";

type Row = { id: string; deal_id: string | null };
type State = { kind: "reading" | "unavailable" | "hidden" } | { kind: "confirmed"; watches: Watch[] };
export function mountRadarWatches(host: HTMLElement, read = createWatchListReader()) {
  let state: State = { kind: "reading" };
  let rows: Row[] = [];
  let sequence = 0;
  let retired = false;
  let controller = new AbortController();
  const versions = new Map<string, number>();
  const paint = () => {
    for (const node of host.querySelectorAll<HTMLElement>("[data-radar-watch]")) {
      const row = rows.find((row) => row.id === node.dataset.radarWatch);
      node.textContent =
        !row || !isWatchSubjectId(row.id)
          ? "Watch identity unavailable"
          : state.kind === "confirmed"
            ? watchSummary(state.watches, row.id, row.deal_id)
            : {
                reading: "Reading watch states…",
                unavailable: "Watch states unavailable",
                hidden: "Sign in to inspect watches",
              }[state.kind];
    }
  };
  const refresh = async () => {
    if (retired) return;
    if (!rows.some((row) => isWatchSubjectId(row.id))) {
      state = { kind: "unavailable" };
      paint();
      return;
    }
    const epoch = ++sequence;
    controller.abort();
    controller = new AbortController();
    state = { kind: "reading" };
    paint();
    try {
      const watches = await read(controller.signal);
      if (retired || epoch !== sequence) return;
      if (watches.some((watch) => watch.lifecycle_version < (versions.get(watch.id) ?? 0)))
        throw Error("Watch list regressed. Refresh.");
      versions.clear();
      for (const watch of watches) versions.set(watch.id, watch.lifecycle_version);
      state = { kind: "confirmed", watches };
    } catch {
      if (retired || epoch !== sequence) return;
      state = { kind: "unavailable" };
    }
    paint();
  };
  const retire = () => {
    retired = true;
    sequence++;
    controller.abort();
    state = { kind: "hidden" };
    versions.clear();
    paint();
  };
  const changed = () => {
    void refresh();
  };
  window.addEventListener("doctorcre-session-invalidated", retire);
  window.addEventListener("doctorcre-watch-confirmed", changed);
  return {
    paint(next: Row[]) {
      rows = next;
      paint();
    },
    refresh,
    dispose() {
      retire();
      window.removeEventListener("doctorcre-session-invalidated", retire);
      window.removeEventListener("doctorcre-watch-confirmed", changed);
    },
  };
}
