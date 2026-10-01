export const route = {
  tour_id: "tour-synthetic-map", projection_id: "projection-synthetic-map", route_version: 3,
  route_version_id: "route-synthetic-v3", canonical_dataset_version: "synthetic-v1", component_registry_version: "map-v1",
  stops: [
    { route_stop_id: "stop-b", property_id: "property-b", route_sequence: 2, route_label: "B", title: "Synthetic Clinic Two", address_line: "200 Example Way", locked_state: "flexible", dwell_minutes: 20, buffer_minutes: 10,
      source_ref: "synthetic:parcel-review", position: { latitude: 30.6102, longitude: -88.0102, coordinate_role: "parcel_centroid", precision_class: "parcel", review_state: "reviewed", human_approved: true } },
    { route_stop_id: "stop-a", property_id: "property-a", route_sequence: 1, route_label: "A", title: "Synthetic Clinic One", address_line: "100 Example Way", locked_state: "locked", dwell_minutes: 30, buffer_minutes: 10,
      source_ref: "synthetic:access-review", position: { latitude: 30.6001, longitude: -88.0001, coordinate_role: "entrance", precision_class: "entrance", review_state: "reviewed", human_approved: true } },
  ],
};
export const receipt = {
  ...Object.fromEntries(["tour_id", "projection_id", "route_version", "route_version_id", "canonical_dataset_version", "component_registry_version"].map(k => [k, route[k]])),
  promotion_receipt_id: "synthetic-approval", decision: "approved", provider_rights_receipt_ids: ["synthetic-rights"],
  required_checks: Object.fromEntries([
    "canonical_address_and_coordinate_review", "claims_and_layers_have_source_as_of_rights_and_review_state", "deterministic_rebuild_from_canonical_record", "exact_native_navigation_handoff", "locked_appointments_dwell_and_buffers_preserved", "map_list_route_offline_order_parity", "no_unresolved_route_critical_unknown_or_conflict", "optional_context_layers_progressively_disclosed", "ordered_offline_itinerary_verified", "phone_and_ipad_interaction_test", "provider_terms_attribution_expiry_and_cost_gate_passed",
  ].map(k => [k, true])),
  mobile_test_evidence: { status: "passed" }, native_navigation_test_evidence: { status: "passed" }, offline_test_evidence: { status: "passed" },
};
