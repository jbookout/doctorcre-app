const reasons = {
  contact_restricted: "Contact restricted",
  conflicting_evidence: "Conflicting evidence needs review",
  expired_evidence: "Recorded evidence has expired",
  verified_usable_route_not_established: "Verified usable route not established",
  recent_successful_contact_not_established: "Recent successful contact not established",
};
type Reason = keyof typeof reasons;
type Reachability = {
  classification: "reachable" | "research";
  evidence_state: "unknown" | "current" | "expired" | "conflicting";
  missing_reasons: Reason[];
  source_revision: string;
  evaluated_at: string;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
type Check = (value: unknown) => boolean;
const string: Check = (value) => typeof value === "string";
const boolean: Check = (value) => typeof value === "boolean";
const uuid: Check = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const date: Check = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const timestamp: Check = (value) => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})[tT ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[zZ]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const beforeLeap = new Date(value.replace(/:60(?=[.zZ+-]|$)/, ":59"));
  const validSecond =
    Number(match[4]) < 60 ||
    (Number(match[4]) === 60 && beforeLeap.getUTCHours() === 23 && beforeLeap.getUTCMinutes() === 59);
  return (
    date(match[1]) &&
    Number(match[2]) < 24 &&
    Number(match[3]) < 60 &&
    validSecond &&
    Number(match[5] || 0) < 24 &&
    Number(match[6] || 0) < 60
  );
};
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const fields = (value: unknown, checks: Record<string, Check>): boolean =>
  object(value) &&
  Object.keys(value).length === Object.keys(checks).length &&
  Object.entries(checks).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const list =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.length <= 500 && value.every(check);
const contact: Check = (value) =>
  fields(value, {
    activity_id: uuid,
    occurred_at: timestamp,
    source: (value) => string(value) && value !== "",
    kind: string,
  });
const route: Check = (value) =>
  fields(value, {
    flag_id: uuid,
    kind: (value) => value === "email" || value === "cell" || value === "office_phone",
  });
const evidence: Check = (value) =>
  fields(value, {
    flag_id: uuid,
    kind: string,
    found: boolean,
    expired: boolean,
    proposes_correction: boolean,
    source: string,
    observed_at: timestamp,
    expires_on: nullable(date),
    value: () => true,
  });
const activity: Check = (value) =>
  fields(value, {
    id: uuid,
    lead_id: uuid,
    kind: string,
    connected: nullable(boolean),
    occurred_at: timestamp,
    source: string,
    detail: nullable(string),
  });
const sourceInputs: Check = (value) =>
  fields(value, {
    party_id: uuid,
    created_at: timestamp,
    email: nullable(string),
    cell: nullable(string),
    phone: nullable(string),
    activities: list(activity),
  });
function invalid(): never {
  throw Object.assign(new Error("Reachability response refused"), { code: "invalid_projection" });
}
export function parseReachability(value: unknown): Reachability | null {
  if (value === undefined) return null;
  if (
    !object(value) ||
    !fields(value, {
      schema_version: (value) => value === "lead-reachability.v2",
      basis: (value) => value === "successful_contact_and_current_route",
      classification: (value) => value === "reachable" || value === "research",
      evidence_state: (value) =>
        value === "unknown" || value === "current" || value === "expired" || value === "conflicting",
      source_revision: (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value),
      evaluated_at: timestamp,
      missing_reasons: (value) =>
        Array.isArray(value) &&
        new Set(value).size === value.length &&
        value.every((reason) => typeof reason === "string" && Object.hasOwn(reasons, reason)),
      contact_eligible: nullable(boolean),
      research_state: (value) => value === "needs_research" || value === "needs_review" || value === "verified",
      contact_freshness_days: (value) => value === 90,
      evidence: list(evidence),
      successful_contact: nullable(contact),
      usable_route: nullable(route),
      source_inputs: nullable(sourceInputs),
    })
  )
    return invalid();
  const missing: Reason[] = [];
  if (!Array.isArray(value.missing_reasons)) return invalid();
  for (const reason of value.missing_reasons) {
    const key = Object.keys(reasons).find((key): key is Reason => key === reason);
    if (!key) return invalid();
    missing.push(key);
  }
  if (
    value.classification === "reachable" &&
    (value.contact_eligible !== true ||
      !object(value.successful_contact) ||
      !object(value.usable_route) ||
      value.evidence_state === "conflicting" ||
      missing.length)
  )
    return invalid();
  if (
    (value.classification !== "reachable" && value.classification !== "research") ||
    (value.evidence_state !== "unknown" &&
      value.evidence_state !== "current" &&
      value.evidence_state !== "expired" &&
      value.evidence_state !== "conflicting") ||
    typeof value.source_revision !== "string" ||
    typeof value.evaluated_at !== "string"
  )
    return invalid();
  return {
    classification: value.classification,
    evidence_state: value.evidence_state,
    missing_reasons: missing,
    source_revision: value.source_revision,
    evaluated_at: value.evaluated_at,
  };
}
export function reachabilityText(value: unknown): string {
  const read = parseReachability(value);
  if (!read) return "Research · Unknown reachability";
  if (read.classification === "reachable") return "Reachable · Successful contact and current verified route";
  return `Research · ${read.evidence_state === "unknown" ? "Unknown. " : ""}${read.missing_reasons.map((reason) => reasons[reason]).join(". ") || "Research needed"}`;
}
