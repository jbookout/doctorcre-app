export type Subject = { subject_type: "deal" | "lease"; subject_id: string };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (): never => {
  throw Error("Watch response unavailable");
};
export const isWatchSubjectId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const version = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
function parsePolicy(value: unknown) {
  if (
    !object(value) ||
    !exact(value, ["change_kinds", "include_self_changes", "lease_threshold_days"]) ||
    !Array.isArray(value.change_kinds) ||
    !value.change_kinds.length ||
    value.change_kinds.length > 3 ||
    new Set(value.change_kinds).size !== value.change_kinds.length ||
    typeof value.include_self_changes !== "boolean"
  )
    return invalid();
  const change_kinds = value.change_kinds.map((kind: unknown) => {
    if (kind === "reply_arrived" || kind === "lease_threshold_crossed" || kind === "listing_status_changed")
      return kind;
    return invalid();
  });
  let lease_threshold_days: number[] | undefined;
  if ("lease_threshold_days" in value) {
    if (
      !Array.isArray(value.lease_threshold_days) ||
      !value.lease_threshold_days.length ||
      value.lease_threshold_days.length > 20 ||
      new Set(value.lease_threshold_days).size !== value.lease_threshold_days.length
    )
      return invalid();
    lease_threshold_days = value.lease_threshold_days.map((day: unknown) => {
      if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 3650) return invalid();
      return day;
    });
  }
  if (change_kinds.includes("lease_threshold_crossed") && !lease_threshold_days) return invalid();
  return {
    change_kinds,
    include_self_changes: value.include_self_changes,
    ...(lease_threshold_days ? { lease_threshold_days } : {}),
  };
}
export type Policy = ReturnType<typeof parsePolicy>;
function parseSingle(value: unknown, subject: Subject) {
  if (
    !object(value) ||
    !exact(value, [
      "id",
      "actor_id",
      "subject_id",
      "subject_type",
      "state",
      "policy",
      "lifecycle_version",
      "baseline",
      "subscribed_at",
    ]) ||
    !isWatchSubjectId(value.id) ||
    !isWatchSubjectId(value.actor_id) ||
    value.subject_id !== subject.subject_id ||
    !isWatchSubjectId(value.subject_id) ||
    value.subject_type !== subject.subject_type ||
    !version(value.lifecycle_version) ||
    typeof value.subscribed_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.subscribed_at) ||
    !Number.isFinite(Date.parse(value.subscribed_at)) ||
    new Date(`${value.subscribed_at.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
      value.subscribed_at.slice(0, 10)
  )
    return invalid();
  const state = value.state;
  if (state !== "watching" && state !== "paused" && state !== "removed") return invalid();
  const baseline = value.baseline;
  if (
    !object(baseline) ||
    !exact(baseline, ["schema_version", "subject_type", "subject_id", "version"]) ||
    baseline.schema_version !== "subject-watch-baseline.v1" ||
    baseline.subject_type !== subject.subject_type ||
    baseline.subject_id !== subject.subject_id ||
    !version(baseline.version)
  )
    return invalid();
  return {
    id: value.id,
    actor_id: value.actor_id,
    subject_id: value.subject_id,
    subject_type: value.subject_type,
    state,
    policy: parsePolicy(value.policy),
    lifecycle_version: value.lifecycle_version,
    baseline: {
      schema_version: baseline.schema_version,
      subject_type: baseline.subject_type,
      subject_id: baseline.subject_id,
      version: baseline.version,
    },
    subscribed_at: value.subscribed_at,
  };
}
export type Watch = ReturnType<typeof parseSingle>;
export function parseWatch(value: unknown, subject: Subject): Watch | null {
  if (
    !object(value) ||
    value.ok !== true ||
    value.schema_version !== "subject-watch.v2" ||
    !("watch" in value) ||
    "watches" in value ||
    ("has_more" in value && typeof value.has_more !== "boolean") ||
    ("next_cursor" in value && value.next_cursor !== null && !isWatchSubjectId(value.next_cursor)) ||
    ("rows_changed" in value &&
      (typeof value.rows_changed !== "number" ||
        !Number.isInteger(value.rows_changed) ||
        value.rows_changed < 0 ||
        value.rows_changed > 1))
  )
    return invalid();
  return value.watch === null ? null : parseSingle(value.watch, subject);
}
export const defaultPolicy = (subject: Subject): Policy => ({
  change_kinds: subject.subject_type === "deal" ? ["reply_arrived"] : ["lease_threshold_crossed"],
  include_self_changes: true,
  ...(subject.subject_type === "lease" ? { lease_threshold_days: [30, 90] } : {}),
});
