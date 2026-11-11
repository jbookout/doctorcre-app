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
function invalid(): never {
  throw Object.assign(new Error("Reachability response refused"), { code: "invalid_projection" });
}
export function parseReachability(value: unknown): Reachability | null {
  if (value === undefined) return null;
  if (
    !object(value) ||
    value.schema_version !== "lead-reachability.v2" ||
    value.basis !== "successful_contact_and_current_route" ||
    (value.classification !== "reachable" && value.classification !== "research") ||
    (value.evidence_state !== "unknown" &&
      value.evidence_state !== "current" &&
      value.evidence_state !== "expired" &&
      value.evidence_state !== "conflicting") ||
    typeof value.source_revision !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.source_revision) ||
    typeof value.evaluated_at !== "string" ||
    !Number.isFinite(Date.parse(value.evaluated_at)) ||
    !Array.isArray(value.missing_reasons) ||
    (value.contact_eligible !== true && value.contact_eligible !== false && value.contact_eligible !== null) ||
    !["needs_research", "needs_review", "verified"].includes(String(value.research_state)) ||
    value.contact_freshness_days !== 90 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 500
  )
    return invalid();
  const missing: Reason[] = [];
  for (const reason of value.missing_reasons) {
    if (typeof reason !== "string" || !Object.hasOwn(reasons, reason)) return invalid();
    const key = Object.keys(reasons).find((key): key is Reason => key === reason);
    if (!key || missing.includes(key)) return invalid();
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
  if (!read) return "Research · Unknown. Reachability evidence unavailable.";
  if (read.classification === "reachable") return "Reachable · Successful contact and current verified route";
  return `Research · ${read.evidence_state === "unknown" ? "Unknown. " : ""}${read.missing_reasons.map((reason) => reasons[reason]).join(". ") || "Research needed"}`;
}
