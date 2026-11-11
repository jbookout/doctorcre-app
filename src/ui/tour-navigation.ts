export const NAVIGATION_CONTRACT = "tour-navigation-evidence.v1";
export const COMPONENT_VERSION = "maplibre-6.4.1";
export const EVIDENCE_TTL_MS = 5 * 60 * 1000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const digest = (value: unknown) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const passed = (value: unknown) => record(value).status === "passed";
const fresh = (value: unknown, now: number) =>
  typeof value === "string" && Date.parse(value) <= now && now - Date.parse(value) < EVIDENCE_TTL_MS;
const CHECKS = [
  "canonical_address_and_coordinate_review",
  "claims_and_layers_have_source_as_of_rights_and_review_state",
  "deterministic_rebuild_from_canonical_record",
  "exact_native_navigation_handoff",
  "locked_appointments_dwell_and_buffers_preserved",
  "map_list_route_offline_order_parity",
  "no_unresolved_route_critical_unknown_or_conflict",
  "optional_context_layers_progressively_disclosed",
  "ordered_offline_itinerary_verified",
  "phone_and_ipad_interaction_test",
  "provider_terms_attribution_expiry_and_cost_gate_passed",
];
type RouteBinding = {
  id: string;
  route_version: number;
  stops: { id: string; property_id: string; route_sequence: number; route_label: string; stop_state: string }[];
};

export function navigationFromEvidence(tourId: string, route: RouteBinding, input: unknown, now = Date.now()) {
  const navigation = record(input),
    evidence = record(navigation.evidence),
    promotion = record(evidence.promotion);
  if (
    navigation.contract_version !== NAVIGATION_CONTRACT ||
    navigation.status !== "ready" ||
    navigation.reason !== null ||
    evidence.route_version_id !== route.id ||
    evidence.route_version !== route.route_version ||
    !text(evidence.projection_id) ||
    !Number.isInteger(evidence.projection_version) ||
    Number(evidence.projection_version) < 1 ||
    !digest(evidence.projection_digest) ||
    !fresh(evidence.as_of, now) ||
    promotion.route_version !== route.route_version ||
    promotion.component_registry_version !== COMPONENT_VERSION ||
    !text(promotion.canonical_dataset_version) ||
    !text(promotion.receipt_id) ||
    !digest(promotion.receipt_digest) ||
    !text(promotion.reviewer_actor_id) ||
    !text(promotion.reviewed_at) ||
    !text(promotion.brief_version) ||
    !text(promotion.selected_prototype_id) ||
    !Array.isArray(promotion.provider_rights_receipt_ids) ||
    !promotion.provider_rights_receipt_ids.length ||
    !promotion.provider_rights_receipt_ids.every(text) ||
    !CHECKS.every((key) => record(promotion.required_checks)[key] === true) ||
    !["mobile_test_evidence", "native_navigation_test_evidence", "offline_test_evidence"].every((key) =>
      passed(promotion[key]),
    ) ||
    !Array.isArray(evidence.stops)
  )
    return null;
  const positions = new Map<
    string,
    {
      latitude: number;
      longitude: number;
      coordinate_role: string;
      precision_class: string;
      review_state: string;
      human_approved: boolean;
      source_ref: string;
    }
  >();
  const active = route.stops.filter((stop) => stop.stop_state === "active");
  if (evidence.stops.length !== active.length) return null;
  for (const value of evidence.stops) {
    const stop = record(value),
      point = record(stop.position),
      source = record(stop.source);
    const match = active.find(
      (item) =>
        item.id === stop.route_stop_id &&
        item.property_id === stop.property_id &&
        item.route_sequence === stop.route_sequence &&
        item.route_label === stop.route_label,
    );
    if (
      !match ||
      positions.has(match.id) ||
      typeof point.latitude !== "number" ||
      !Number.isFinite(point.latitude) ||
      Math.abs(point.latitude) > 90 ||
      typeof point.longitude !== "number" ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.longitude) > 180 ||
      !text(source.coordinate_role) ||
      !["entrance", "driveway", "parking_access"].includes(source.coordinate_role) ||
      !text(source.precision_class) ||
      !["entrance", "surveyed"].includes(source.precision_class) ||
      source.review_state !== "reviewed" ||
      source.retrieval_status !== "read" ||
      !digest(source.receipt_digest) ||
      !passed(source.native_navigation_proof) ||
      !text(source.rights_receipt_id) ||
      !promotion.provider_rights_receipt_ids.includes(source.rights_receipt_id) ||
      ![
        "coordinate_candidate_id",
        "source_evidence_id",
        "stable_locator",
        "observed_at",
        "retrieved_at",
        "rights_receipt_id",
        "entrance_verification_receipt_id",
        "verifier_actor_id",
        "verified_at",
        "evidence_reference",
      ].every((key) => text(source[key])) ||
      !text(source.stable_locator)
    )
      return null;
    positions.set(match.id, {
      latitude: point.latitude,
      longitude: point.longitude,
      coordinate_role: source.coordinate_role,
      precision_class: source.precision_class,
      review_state: "reviewed",
      human_approved: true,
      source_ref: source.stable_locator,
    });
  }
  return {
    positions,
    projection_id: evidence.projection_id,
    canonical_dataset_version: promotion.canonical_dataset_version,
    component_registry_version: COMPONENT_VERSION,
    expires_at: Date.parse(String(evidence.as_of)) + EVIDENCE_TTL_MS,
    evidence_binding: JSON.stringify([
      evidence.projection_id,
      evidence.projection_version,
      evidence.projection_digest,
      promotion.receipt_id,
      promotion.receipt_digest,
    ]),
    promotion_receipt: {
      ...promotion,
      tour_id: tourId,
      route_version_id: route.id,
      projection_id: evidence.projection_id,
      decision: "approved",
      promotion_receipt_id: promotion.receipt_id,
    },
  };
}
