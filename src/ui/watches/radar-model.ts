import { isWatchSubjectId, parseWatch, type Watch } from "./model.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function parseWatchPage(value: unknown) {
  if (
    !object(value) ||
    value.ok !== true ||
    value.schema_version !== "subject-watch.v2" ||
    !Array.isArray(value.watches) ||
    value.watches.length > 100 ||
    typeof value.has_more !== "boolean" ||
    (value.has_more ? !isWatchSubjectId(value.next_cursor) : value.next_cursor !== null)
  )
    throw Error("Watch list unavailable");
  const watches = value.watches.map((entry: unknown) => {
    if (
      !object(entry) ||
      (entry.subject_type !== "deal" && entry.subject_type !== "lease") ||
      !isWatchSubjectId(entry.subject_id)
    )
      throw Error("Watch list unavailable");
    const watch = parseWatch(
      { ok: true, schema_version: "subject-watch.v2", watch: entry },
      { subject_type: entry.subject_type, subject_id: entry.subject_id },
    );
    if (!watch || watch.state === "removed") throw Error("Watch list unavailable");
    return watch;
  });
  if (new Set(watches.map((watch) => `${watch.subject_type}:${watch.subject_id}`)).size !== watches.length)
    throw Error("Duplicate watch subjects");
  return { watches, next: typeof value.next_cursor === "string" ? value.next_cursor : null };
}
export function watchSummary(watches: Watch[], lease: string, deal: string | null) {
  const direct = watches.find((watch) => watch.subject_type === "lease" && watch.subject_id === lease);
  const linked = watches.find(
    (watch) =>
      watch.subject_type === "deal" &&
      watch.subject_id === deal &&
      watch.policy.change_kinds.includes("lease_threshold_crossed"),
  );
  const label = (watch: Watch) =>
    `${watch.state === "paused" ? "paused" : "watching"}${
      watch.policy.lease_threshold_days
        ? ` · ${watch.policy.lease_threshold_days.join(", ")} days before the lease date`
        : ""
    }`;
  return [`Lease ${direct ? label(direct) : "not watching"}`, ...(linked ? [`Linked deal ${label(linked)}`] : [])].join(
    " · ",
  );
}
