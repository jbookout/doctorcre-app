import { createPageBudget } from './read-budget.mjs';
// The Control Room's one queue (V2 step 3, slice C1). Pure: no DOM, no client.
// Rows arrive in the record layer's own vocabulary (`unfinished-work.v1`,
// `incident-board`, `current-work-item`) and leave as one issue shape that the
// Queue, Triage and Views sections share. Nothing here guesses: an unknown kind
// keeps a readable label, an unknown state lands in "Other", and a census that
// did not read every source says so in its coverage line.

export const SECTION_KEYS = Object.freeze(["inbox", "waiting", "triage", "queue", "views", "boards", "approvals",
  "automations", "connections", "agents", "system-map", "sessions"]);
// Old `?tab=` keys from the seven-tab layout, plus their older aliases.
const LEGACY_TABS = Object.freeze({ overview: "boards", dashboard: "boards", attention: "views",
  "model-room": "agents", atlas: "system-map" });
export const DEFAULT_SECTION = "queue";
export const sectionForTab = (key) => SECTION_KEYS.includes(key) ? key : LEGACY_TABS[key] || DEFAULT_SECTION;

const KIND_LABELS = Object.freeze({ work_request: "Work Request", incident: "Incident", defect: "Defect", loop: "Loop",
  work_shape: "Work shape", builder_brief: "Builder brief", slice_plan: "Slice plan",
  capability_session: "Capability session", retrieval_proposal: "Retrieval proposal" });
const humanize = (text) => { const words = String(text || "").replace(/_/g, " ").trim(); return words ? words[0].toUpperCase() + words.slice(1) : "Unknown"; };
export const kindLabel = (kind) => KIND_LABELS[kind] || humanize(kind);

// Study #0 (decision a03433bb): captured, detected and untracked rows belong to
// Triage, so the Queue and the built-in views leave them out unless asked.
const TRIAGE_STATES = new Set(["captured", "detected", "fix_untracked"]);
export const isTriageState = (state) => TRIAGE_STATES.has(state);

export const STATUS_GROUPS = Object.freeze([
  { key: "triage", label: "Needs triage" }, { key: "in_progress", label: "In progress" },
  { key: "review", label: "In review" }, { key: "blocked", label: "Blocked" },
  { key: "ready", label: "Ready" }, { key: "backlog", label: "Backlog" },
  { key: "closed", label: "Closed" }, { key: "other", label: "Other" },
]);
// Every state the record layer defines (carr-system migrations 0114 ops.work_request,
// 0115 ops.incident, 0024 loop_item) plus the census's own derived states.
// `needs_joe` is a Work Request waiting on Joe: it cannot move, so it is Blocked.
const GROUP_OF_STATE = {
  captured: "triage", detected: "triage", fix_untracked: "triage",
  claimed: "in_progress", in_progress: "in_progress", investigating: "in_progress", mitigating: "in_progress", reopened: "in_progress",
  verification: "review", awaiting_release: "review", released: "review", review: "review", monitoring: "review", pending: "review",
  needs_joe: "blocked", blocked: "blocked", failed: "blocked", needs_answer: "blocked", stale: "blocked",
  ready: "ready", triaged: "ready",
  open: "backlog", queued: "backlog", unmarked: "backlog",
  confirmed_closed: "closed", declined: "closed", superseded: "closed", resolved: "closed", reviewed: "closed",
  done: "closed", dropped: "closed", complete: "closed", accepted: "closed",
};
export const statusGroup = (_kind, state) => GROUP_OF_STATE[state] || "other";

const text = (value) => typeof value === "string" && value.trim() !== "";
const short = (id) => String(id).slice(0, 8);
function refFor(row) {
  const identity = row.identity || {};
  switch (row.kind) {
    case "work_request": return identity.human_ref || row.id;
    case "incident": return identity.ref || row.id;
    case "work_shape": case "builder_brief": case "slice_plan": case "ready_plan_amendment":
      return identity.work_request || identity.human_ref || row.id;
    case "defect": return `DEF-${short(row.id)}`;
    case "loop": return `LOOP-${short(row.id)}`;
    case "capability_session": return `SESSION-${short(row.id)}`;
    case "retrieval_proposal": return `RP-${short(row.id)}`;
    default: return row.id;
  }
}

export function validCensus(payload) {
  return Boolean(payload) && payload.schema === "unfinished-work.v1" && Array.isArray(payload.items)
    && Array.isArray(payload.coverage) && (payload.census_complete === undefined || typeof payload.census_complete === "boolean")
    && (payload.next_cursor == null || typeof payload.next_cursor === "string");
}

function normalizeItem(row, { incidents, holders }) {
  if (!row || !text(row.kind) || row.id == null || String(row.id) === "") return null;
  const id = String(row.id), ref = refFor({ ...row, id });
  const incident = row.kind === "incident" ? incidents.get(ref) : null;
  return {
    id: `${row.kind}:${id}`, kind: row.kind, kindLabel: kindLabel(row.kind), ref: String(ref),
    title: text(row.title) ? row.title : ref, statusGroup: statusGroup(row.kind, row.state), state: row.state ?? null,
    source: row.source ?? row.source_ref ?? null, owner: text(row.owner) ? row.owner : null,
    age: Number.isFinite(row.age) ? row.age : null, version: row.version ?? null, link: text(row.link) ? row.link : null,
    openedAt: text(row.opened_at) ? row.opened_at : null, lastActivityAt: text(row.last_activity_at) ? row.last_activity_at : null,
    loopKind: row.kind === "loop" && text(row.identity?.kind) ? row.identity.kind : null,
    triageActions: (Array.isArray(row.available_triage_actions) ? row.available_triage_actions : [])
      .map(({ action, verb, args, fields, versioned }) => ({ action, verb, args: args ?? {}, fields: fields ?? [], versioned: versioned === true })),
    holder: holders.get(ref) ?? null,
    severity: incident?.severity ?? null, occurrences: Number.isFinite(incident?.occurrences) ? incident.occurrences : null,
  };
}

export const createQueue = () => ({ items: [], coverage: [], censusComplete: null, nextCursor: null, pages: 0 });

// One page of `unfinished-work`. Later pages append; a row seen twice keeps its
// newest reading. Coverage and the cursor always come from the latest page.
export function addPage(queue, census, { incidents = null, current = null } = {}) {
  if (!validCensus(census)) throw new Error("Invalid unfinished-work read");
  const incidentRows = new Map((Array.isArray(incidents?.incidents) ? incidents.incidents : []).filter((r) => text(r?.ref)).map((r) => [r.ref, r]));
  const holders = new Map((Array.isArray(current?.current) ? current.current : []).filter((r) => text(r?.human_ref))
    .map((r) => [r.human_ref, text(r.executor) ? r.executor : text(r.owner) ? r.owner : null]));
  const byId = new Map(queue.items.map((item) => [item.id, item]));
  for (const row of census.items) { const item = normalizeItem(row, { incidents: incidentRows, holders }); if (item) byId.set(item.id, item); }
  return { items: [...byId.values()], coverage: census.coverage.slice(), censusComplete: census.census_complete === true,
    nextCursor: census.next_cursor ?? null, pages: queue.pages + 1 };
}

export const queueItems = (queue, { includeTriage = false } = {}) =>
  includeTriage ? queue.items.slice() : queue.items.filter((item) => !isTriageState(item.state));

// Re-read as many pages as were loaded, from page one, so an automatic refresh
// never throws away what "Load more" fetched and rows gone at the source leave.
export async function refreshQueue(queue, readPage, context = {}) {
  const wanted = Math.max(1, queue.pages);
  let fresh = createQueue(), cursor = null;
  const takePage = createPageBudget();
  // eslint-disable-next-line no-restricted-syntax -- Queue catch-up calls takePage before each retained page; at most 100 pages per refresh.
  do { takePage(); fresh = addPage(fresh, await readPage(cursor), context); cursor = fresh.nextCursor; }
  while (cursor && fresh.pages < wanted);
  return fresh;
}

// A refresh that was in flight while "Load more" landed holds fewer pages than
// the queue now shows. Keep the larger queue; the next refresh re-reads it all.
export const settleRefresh = (current, refreshed) => (refreshed.pages < current.pages ? current : refreshed);

// X2: defects have no triage action yet, so they live in a Bugs view beside incidents.
export const bugItems = (queue) => queue.items.filter((item) => item.kind === "defect" || item.kind === "incident");

// X2: untracked defects have no allowed first transition, so Triage lists only
// triage-state rows the record layer offers an action for.
export const triageItems = (queue) => queue.items.filter((item) => isTriageState(item.state) && item.triageActions.length > 0);

export const groupItems = (items) => STATUS_GROUPS
  .map((group) => ({ ...group, items: items.filter((item) => item.statusGroup === group.key) }))
  .filter((group) => group.items.length > 0);

const count = (n) => n.toLocaleString("en-US");
const SOURCE_STATE = { partial: "Partly read", unavailable: "Not read" };
export const REASON_WORDS = {
  fix_status_not_recorded: "fix status not recorded",
  github_cache_unavailable: "GitHub data could not be read",
  github_cache_missing_stale_or_incomplete: "GitHub data has not been refreshed",
  unstructured_brief_pr_relationships: "links to pull requests are not recorded",
  cache_contains_open_github_work_only: "only open GitHub work is known",
  external_history_pages_missing_or_invalid: "some GitHub history is missing",
  rows_rejected_invalid_dates_or_identity: "some rows had unreadable dates",
  rows_missing_dates: "some rows have no dates",
  count_unavailable: "the total is not known",
  DEPENDENCY_UNAVAILABLE: "this source could not be reached",
  source_read_failed: "this source could not be read",
};
const sentence = (state, reason) => {
  const head = SOURCE_STATE[state] || humanize(state);
  const why = reason ? REASON_WORDS[reason] || humanize(reason).toLowerCase() : null;
  return why ? `${head}: ${why}` : head;
};
// One short line for the default view; per-source detail, in plain words, for a disclosure.
export function coverageLine(queue) {
  if (queue.pages === 0) return { complete: false, text: "Queue not read yet", details: [] };
  const loaded = queue.items.length;
  const details = queue.coverage.filter((source) => source.state !== "complete")
    .map((source) => ({ source: kindLabel(source.kind), text: sentence(source.state, source.reason) }));
  const complete = queue.censusComplete === true && details.length === 0 && !queue.nextCursor;
  if (complete) return { complete, text: `${count(loaded)} ${loaded === 1 ? "item" : "items"} · every source read`, details };
  return { complete, details, text: [`${count(loaded)} loaded`, queue.nextCursor ? "more to load" : null,
    details.length ? `${details.length} ${details.length === 1 ? "source" : "sources"} incomplete` : null].filter(Boolean).join(" · ") };
}
