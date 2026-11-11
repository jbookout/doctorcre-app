type Source = "activity" | "note" | "event";
export type UpdateEntry = {
  source: Source;
  id: string;
  at: string;
  actor: string | null;
  text: string;
  original: Record<string, unknown>;
};
export type UpdateSummary = {
  schema_version: "deal-update-summary.v1";
  deal_id: string;
  source_revision: string;
  summary: { method: "extractive"; text: string; citations: { source: Source; id: string; at: string }[] };
  coverage: {
    complete: boolean;
    unsupported_events_present: boolean;
    covered_count: number;
    read_count_lower_bound: number;
    sources_read: Source[];
    sources_missing: Source[];
    window: { oldest: string; newest: string } | null;
  };
  history: { entries: UpdateEntry[]; next_cursor: string | null; revision: string; order: "at/source/id descending" };
};
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const source = (v: unknown): v is Source => v === "activity" || v === "note" || v === "event";
const string = (v: unknown): v is string => typeof v === "string";
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nullable = (v: unknown): v is string | null => v === null || string(v);
const stamp = (v: unknown): v is string =>
  string(v) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v) && Number.isFinite(Date.parse(v));
function citation(v: unknown): { source: Source; id: string; at: string } {
  if (!object(v) || !source(v.source) || !string(v.id) || !stamp(v.at)) throw Error("Invalid source citation");
  return { source: v.source, id: v.id, at: v.at };
}
export function parseDealUpdateSummary(v: unknown, dealId: string): UpdateSummary {
  if (
    !object(v) ||
    v.schema_version !== "deal-update-summary.v1" ||
    v.deal_id !== dealId ||
    !string(v.source_revision) ||
    !v.source_revision ||
    !object(v.summary) ||
    v.summary.method !== "extractive" ||
    !string(v.summary.text) ||
    !Array.isArray(v.summary.citations) ||
    !object(v.coverage) ||
    !object(v.history)
  )
    throw Error("Deal updates unavailable");
  const c = v.coverage,
    h = v.history;
  if (
    typeof c.complete !== "boolean" ||
    typeof c.unsupported_events_present !== "boolean" ||
    !count(c.covered_count) ||
    !count(c.read_count_lower_bound) ||
    !Array.isArray(c.sources_read) ||
    !c.sources_read.every(source) ||
    !Array.isArray(c.sources_missing) ||
    !c.sources_missing.every(source) ||
    !Array.isArray(h.entries) ||
    h.entries.length > 100 ||
    !nullable(h.next_cursor) ||
    (h.next_cursor !== null && (!h.next_cursor || h.next_cursor.length > 4096)) ||
    h.order !== "at/source/id descending" ||
    h.revision !== v.source_revision
  )
    throw Error("Invalid update coverage");
  let window: { oldest: string; newest: string } | null = null;
  if (c.window !== null) {
    if (!object(c.window) || !stamp(c.window.oldest) || !stamp(c.window.newest)) throw Error("Invalid citation window");
    window = { oldest: c.window.oldest, newest: c.window.newest };
  }
  const citations = v.summary.citations.map(citation);
  if (
    citations.length ? window?.oldest !== citations[0]?.at || window?.newest !== citations.at(-1)?.at : window !== null
  )
    throw Error("Citation window disagrees with sources");
  if (
    c.covered_count !== citations.length ||
    c.read_count_lower_bound < c.covered_count ||
    c.sources_missing.length ||
    new Set(c.sources_read).size !== 3 ||
    (c.complete &&
      (c.unsupported_events_present || c.covered_count >= 9 || c.covered_count !== c.read_count_lower_bound))
  )
    throw Error("Incomplete update source contract");
  const entries = h.entries.map((row: unknown): UpdateEntry => {
    const identity = citation(row);
    if (
      !object(row) ||
      !nullable(row.actor) ||
      !string(row.text) ||
      !object(row.original) ||
      row.original.id !== identity.id
    )
      throw Error("Invalid original update");
    return { ...identity, actor: row.actor, text: row.text, original: row.original };
  });
  const identities = new Set(entries.map((e) => `${e.source}:${e.id}`));
  if (identities.size !== entries.length) throw Error("Repeated update identity");
  if (
    entries.some((b, i) => {
      const a = entries[i - 1];
      return a !== undefined && `${a.at}/${a.source}/${a.id}` < `${b.at}/${b.source}/${b.id}`;
    })
  )
    throw Error("Invalid update order");
  return {
    schema_version: "deal-update-summary.v1",
    deal_id: dealId,
    source_revision: v.source_revision,
    summary: { method: "extractive", text: v.summary.text, citations },
    coverage: {
      complete: c.complete,
      unsupported_events_present: c.unsupported_events_present,
      covered_count: c.covered_count,
      read_count_lower_bound: c.read_count_lower_bound,
      sources_read: c.sources_read,
      sources_missing: c.sources_missing,
      window,
    },
    history: { entries, next_cursor: h.next_cursor, revision: v.source_revision, order: "at/source/id descending" },
  };
}
type Load<T> = { kind: "idle" | "loading" | "error" } | { kind: "ready"; value: T };
type State = {
  summary: Load<UpdateSummary>;
  history: Load<null>;
  rows: UpdateEntry[];
  cursor: string | null;
  revision: string | null;
  expanded: boolean;
  retired: boolean;
};
export type SummaryRead = (
  args: { deal_id: string; page_size: number; cursor?: string },
  signal: AbortSignal,
) => Promise<unknown>;
export function createDealUpdateSummary({
  dealId,
  read,
  changed,
  onDenied = () => {},
}: {
  dealId: string;
  read: SummaryRead;
  changed: () => void;
  onDenied?: (error: unknown) => void;
}) {
  let state: State = {
    summary: { kind: "idle" },
    history: { kind: "idle" },
    rows: [],
    cursor: null,
    revision: null,
    expanded: false,
    retired: false,
  };
  let generation = 0;
  const controllers = new Set<AbortController>();
  let historyBusy = false;
  const emit = () => changed();
  const invalidate = () => {
    generation++;
    for (const c of controllers) c.abort();
    controllers.clear();
    historyBusy = false;
  };
  const denied = (error: unknown) =>
    object(error) && "status" in error && (error.status === 401 || error.status === 403);
  const retire = () => {
    invalidate();
    state = {
      summary: { kind: "idle" },
      history: { kind: "idle" },
      rows: [],
      cursor: null,
      revision: null,
      expanded: false,
      retired: true,
    };
    emit();
  };
  async function load(channel: "summary" | "history", cursor?: string): Promise<void> {
    if (state.retired || (channel === "history" && historyBusy)) return;
    const gen = generation,
      c = new AbortController();
    controllers.add(c);
    if (channel === "history") historyBusy = true;
    state = { ...state, [channel]: { kind: "loading" } };
    emit();
    try {
      const raw = await read({ deal_id: dealId, page_size: 50, ...(cursor ? { cursor } : {}) }, c.signal);
      if (gen !== generation || state.retired) return;
      if (object(raw) && raw.error === "stale_history_cursor") {
        if (!cursor) throw Error("Fresh history unavailable");
        historyBusy = false;
        invalidate();
        state = { ...state, rows: [], cursor: null, revision: null, summary: { kind: "loading" } };
        await load("history");
        if (!state.retired && state.summary.kind === "loading") {
          state = { ...state, summary: { kind: "error" } };
          emit();
        }
        return;
      }
      const value = parseDealUpdateSummary(raw, dealId);
      if (channel === "summary") {
        if (state.revision && state.revision !== value.source_revision) return;
        state = { ...state, summary: { kind: "ready", value } };
      } else {
        if (cursor && state.revision !== value.source_revision) throw Error("History revision changed");
        const last = state.rows.at(-1),
          first = value.history.entries[0];
        if (
          cursor &&
          last &&
          first &&
          `${last.at}/${last.source}/${last.id}` <= `${first.at}/${first.source}/${first.id}`
        )
          throw Error("Invalid continuation order");
        const rows = cursor ? [...state.rows, ...value.history.entries] : value.history.entries;
        if (new Set(rows.map((e) => `${e.source}:${e.id}`)).size !== rows.length) throw Error("Repeated continuation");
        state = {
          ...state,
          summary: { kind: "ready", value },
          history: { kind: "ready", value: null },
          rows,
          cursor: value.history.next_cursor,
          revision: value.source_revision,
        };
      }
    } catch (error) {
      if (gen !== generation || state.retired) return;
      if (denied(error)) {
        retire();
        onDenied(error);
        return;
      }
      if (
        channel === "summary" &&
        state.summary.kind === "ready" &&
        state.revision === state.summary.value.source_revision
      )
        return;
      state = { ...state, [channel]: { kind: "error" } };
    } finally {
      controllers.delete(c);
      if (gen === generation) {
        if (channel === "history") historyBusy = false;
        emit();
      }
    }
  }
  return {
    state: () => state,
    async refresh() {
      if (state.retired) return;
      invalidate();
      state = {
        ...state,
        rows: [],
        cursor: null,
        revision: null,
        history: { kind: "idle" },
        summary: { kind: "loading" },
      };
      emit();
      await Promise.all([load("summary"), ...(state.expanded ? [load("history")] : [])]);
    },
    async expand() {
      if (state.retired) return;
      state = { ...state, expanded: true };
      emit();
      if (state.history.kind === "idle" || (state.history.kind === "error" && !state.rows.length))
        await load("history");
    },
    collapse() {
      state = { ...state, expanded: false };
      emit();
    },
    more() {
      return load("history", state.cursor ?? undefined);
    },
    dispose: retire,
  };
}
