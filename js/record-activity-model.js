// V5-UX-B04 — "Recent activity" on a Vendors or Clients record: every
// decision, no DOM.
//
// The only pinned read that returns a record's timeline is `find-and-catch-up`.
// It finds by NAME and proceeds only on exactly one live match, then returns
// that match's catch-me-up timeline. A name is not an identity: two parties can
// share one, and a vendor's company can match an organization row as well. So
// the timeline is shown ONLY when the single match's own ref is this record's
// ref. Every other outcome is a named state, and no row that might belong to
// another party is ever put under this record's name.
//
// `catch-me-up` takes the exact ref and would remove the name step entirely,
// but it is not pinned in contracts/carr-interface.v1.json; that gap is
// reported rather than widened here.

export const ACTIVITY_LIMIT = 10;
const QUERY_MAX = 200;

/** The one request, or null when the answer could never be verified. */
export function activityRequest(record) {
  const name = typeof record?.name === "string" ? record.name.trim() : "";
  const ref = typeof record?.ref === "string" ? record.ref.trim() : "";
  if (!name || !ref || name.length > QUERY_MAX) return null;
  return { query: name, limit: ACTIVITY_LIMIT };
}

function words(slug) {
  const text = String(slug || "").replace(/[_-]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "Recorded change";
}

/** Only the fields a person reads; the raw `detail` object never leaves here. */
function timelineRow(row) {
  return {
    when: typeof row?.occurred_at === "string" ? row.occurred_at : null,
    actor: typeof row?.actor === "string" && row.actor ? row.actor : null,
    what: typeof row?.summary === "string" && row.summary.trim() ? row.summary.trim() : words(row?.verb),
    kind: row?.entry_kind === "event" ? "event" : "activity",
    owed: typeof row?.owed === "string" && row.owed ? row.owed : null,
  };
}

/** What a find-and-catch-up answer means for THIS record. */
export function activityState(record, answer) {
  const ref = typeof record?.ref === "string" ? record.ref.trim() : "";
  if (!ref) return { state: "no_ref" };
  if (!answer || typeof answer !== "object") return { state: "unavailable" };
  if (answer.state === "not_found") return { state: "not_found" };
  if (answer.state === "needs_disambiguation") {
    const count = Number.isInteger(answer.candidate_count) ? answer.candidate_count
      : Array.isArray(answer.candidates) ? answer.candidates.length : 0;
    return { state: "ambiguous", count };
  }
  if (answer.state !== "completed") return { state: "unavailable" };
  const target = typeof answer.match?.target === "string" ? answer.match.target.trim() : "";
  if (!target || target.toUpperCase() !== ref.toUpperCase()) return { state: "mismatch" };
  const timeline = answer.catch_up?.timeline;
  if (!Array.isArray(timeline)) return { state: "unavailable" };
  const rows = timeline.map(timelineRow);
  return rows.length ? { state: "ready", rows } : { state: "empty", rows: [] };
}

/** Plain copy for every state that is not a list of rows. */
export function activityCopy({ state, count = 0 } = {}) {
  switch (state) {
    case "loading": return "Reading this record's recent activity…";
    case "empty": return "No activity is recorded on this record yet.";
    case "not_found": return "The activity read found no live record under this name, so no activity is shown.";
    case "ambiguous": return `${count} records share this name, and the activity read will not guess which one this is, so none is shown.`;
    case "mismatch": return "The only match for this name is a different record, so its activity is not shown here.";
    case "no_ref": return "This record carries no reference the activity read could be checked against, so none is shown.";
    default: return "Recent activity could not be read. Nothing here has been inferred.";
  }
}
