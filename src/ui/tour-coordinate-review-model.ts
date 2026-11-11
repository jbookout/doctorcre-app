import type { CoordinateReview } from "./tour-coordinate-review-contract.ts";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string";
const nullable = (v: unknown) => v === null || string(v);
const strings = (v: unknown) => v === null || (Array.isArray(v) && v.every(string));
const roles = [
  "parcel_centroid",
  "building_centroid",
  "address_point",
  "geocoder_candidate",
  "entrance",
  "driveway",
  "parking_access",
  "other",
];
const precisions = ["unknown", "approximate", "parcel", "building", "address", "entrance", "surveyed"];
function candidate(v: unknown): v is CoordinateReview["candidates"][number] {
  if (
    !object(v) ||
    !string(v.coordinate_candidate_id) ||
    !string(v.property_id) ||
    !roles.includes(String(v.coordinate_role)) ||
    !precisions.includes(String(v.precision_class)) ||
    !string(v.observed_at) ||
    !["unreviewed", "reviewed", "rejected", "superseded"].includes(String(v.review_state)) ||
    !nullable(v.access_notes)
  )
    return false;
  if (
    v.position !== null &&
    (!object(v.position) ||
      typeof v.position.latitude !== "number" ||
      !Number.isFinite(v.position.latitude) ||
      Math.abs(v.position.latitude) > 90 ||
      typeof v.position.longitude !== "number" ||
      !Number.isFinite(v.position.longitude) ||
      Math.abs(v.position.longitude) > 180)
  )
    return false;
  const s = v.source,
    r = v.rights,
    a = v.approval;
  if (
    !object(s) ||
    !string(s.source_evidence_id) ||
    !["provider", "stable_locator", "retrieved_at", "retrieval_status"].every((k) => nullable(s[k])) ||
    !object(r) ||
    !string(r.rights_receipt_id) ||
    !["usable", "unavailable"].includes(String(r.status)) ||
    !["provider", "policy_key", "terms_url", "effective_at", "expires_at", "revoked_at", "receipt_status"].every((k) =>
      nullable(r[k]),
    ) ||
    !(r.receipt_version === null || (typeof r.receipt_version === "number" && Number.isInteger(r.receipt_version))) ||
    !strings(r.allowed_use_classes) ||
    !strings(r.allowed_field_classes) ||
    !object(a)
  )
    return false;
  if (
    r.status === "unavailable" &&
    (v.position !== null || v.access_notes !== null || s.stable_locator !== null || a.status !== "rights_unavailable")
  )
    return false;
  if (a.status === "verified_entrance") {
    const receipt = a.receipt;
    return (
      r.status === "usable" &&
      v.position !== null &&
      ["entrance", "driveway", "parking_access"].includes(String(v.coordinate_role)) &&
      v.review_state === "reviewed" &&
      object(receipt) &&
      ["verification_receipt_id", "verifier_actor_id", "verified_at", "evidence_reference", "receipt_digest"].every(
        (k) => string(receipt[k]),
      ) &&
      Object.hasOwn(receipt, "native_navigation_proof")
    );
  }
  return (
    ["rights_unavailable", "ineligible_role", "candidate_not_reviewed", "unverified"].includes(String(a.status)) &&
    a.receipt === null
  );
}
type ProducerInstant = { seconds: number; fraction: string };
function producerInstant(value: string): ProducerInstant | null {
  const match =
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match) return null;
  const local = `${match[1]}T${match[2]}:${match[3]}:${match[4]}`;
  const localTime = Date.parse(`${local}Z`);
  if (!Number.isFinite(localTime) || new Date(localTime).toISOString().slice(0, 19) !== local) return null;
  return { seconds: Date.parse(`${local}${match[6]}`) / 1000, fraction: (match[5] ?? "").replace(/0+$/, "") };
}
function newerInstant(next: ProducerInstant, held: ProducerInstant | null): boolean {
  return !held || next.seconds > held.seconds || (next.seconds === held.seconds && next.fraction > held.fraction);
}
function isReview(v: unknown): v is CoordinateReview {
  return (
    object(v) &&
    v.schema === "tour-coordinate-review.v1" &&
    string(v.property_id) &&
    nullable(v.property_name) &&
    nullable(v.property_address) &&
    string(v.as_of) &&
    producerInstant(v.as_of) !== null &&
    Array.isArray(v.candidates) &&
    v.candidates.every(candidate) &&
    new Set(v.candidates.map((c) => c.coordinate_candidate_id)).size === v.candidates.length &&
    v.candidates.every((c) => c.property_id === v.property_id) &&
    ((v.status === "unknown" && v.reason === "no_observed_candidates" && !v.candidates.length) ||
      (v.status === "candidates" && v.reason === null && v.candidates.length > 0)) &&
    Array.isArray(v.property_evidence) &&
    v.property_evidence.every(
      (e) =>
        object(e) &&
        ["field", "review_state", "as_of", "effective_from"].every((k) => string(e[k])) &&
        nullable(e.effective_to) &&
        object(e.source) &&
        nullable(e.source.locator) &&
        nullable(e.source.evidence_class) &&
        nullable(e.source.retrieved_at),
    )
  );
}
export function parseCoordinateReview(input: unknown, propertyId: string): CoordinateReview | null {
  return isReview(input) && input.property_id === propertyId ? input : null;
}
export type ReviewBinding = { session: string; tour: string; route: string; property: string };
export type ReceiptInput = {
  idempotency_key: string;
  property_id: string;
  coordinate_candidate_id: string;
  verified_at: string;
  evidence_reference: string;
  receipt_digest: string;
  native_navigation_proof: { platform: string; tested_at: string; travel_mode: string; evidence_digest: string };
};
export type ReviewResult = "confirmed" | "refused" | "unknown";
type ReviewPhase = "comparing" | "reading" | "unavailable" | "reviewing" | "refused" | "unknown" | "retired";
export function coordinateReviewSession(
  binding: ReviewBinding,
  initial: unknown,
  io: { read: () => Promise<unknown>; write: (args: ReceiptInput) => Promise<ReviewResult>; changed: () => void },
) {
  let phase: ReviewPhase = "comparing",
    review = parseCoordinateReview(initial, binding.property),
    generation = 0;
  let latestAsOf = review ? producerInstant(review.as_of) : null;
  let pending: ReceiptInput | null = null;
  const current = (n: number) => phase !== "retired" && generation === n;
  const changed = () => io.changed();
  const api = {
    get phase() {
      return phase;
    },
    get review() {
      return review;
    },
    async refresh() {
      if (["retired", "reviewing", "unknown"].includes(phase)) return;
      const n = ++generation;
      phase = "reading";
      review = null;
      changed();
      try {
        const value = await io.read();
        if (!current(n)) return;
        const next = parseCoordinateReview(value, binding.property);
        const instant = next ? producerInstant(next.as_of) : null;
        review = next && instant && newerInstant(instant, latestAsOf) ? next : null;
        if (review) latestAsOf = instant;
        phase = review ? "comparing" : "unavailable";
      } catch {
        if (!current(n)) return;
        phase = "unavailable";
      }
      changed();
    },
    async submit(args: ReceiptInput) {
      if (phase !== "comparing" && phase !== "refused") return;
      const c = review?.candidates.find((c) => c.coordinate_candidate_id === args.coordinate_candidate_id);
      if (
        args.property_id !== binding.property ||
        !c ||
        c.rights.status !== "usable" ||
        c.review_state !== "reviewed" ||
        !["entrance", "driveway", "parking_access"].includes(c.coordinate_role)
      ) {
        phase = "refused";
        changed();
        return;
      }
      pending = structuredClone(args);
      await api.resubmit();
    },
    async resubmit() {
      if (!pending || !["comparing", "refused", "unknown"].includes(phase)) return;
      const n = ++generation;
      phase = "reviewing";
      changed();
      let result: ReviewResult = "unknown";
      try {
        result = await io.write(structuredClone(pending));
      } catch {}
      if (!current(n)) return;
      if (result === "confirmed") {
        pending = null;
        phase = "comparing";
        await api.refresh();
      } else {
        phase = result === "refused" ? "refused" : "unknown";
        if (result === "refused") pending = null;
        changed();
      }
    },
    retire() {
      ++generation;
      phase = "retired";
      review = null;
      pending = null;
      changed();
    },
  };
  return api;
}

export function entranceReceiptResult(payload: unknown, isError: boolean): ReviewResult {
  if (!object(payload)) return "unknown";
  if (
    !isError &&
    payload.ok === true &&
    typeof payload.verification_receipt_id === "string" &&
    /^[a-f0-9-]{36}$/i.test(payload.verification_receipt_id)
  )
    return "confirmed";
  return [
    "tour_human_verification_required",
    "human_only_verb_requires_verified_partner",
    "unattended_runner_authority_not_admitted",
    "tour_write_refused",
    "forbidden_authority_field",
  ].includes(String(payload.error))
    ? "refused"
    : "unknown";
}
