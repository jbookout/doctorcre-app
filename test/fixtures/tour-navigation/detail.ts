import { COMPONENT_VERSION } from "../../../src/ui/tour-navigation.ts";
import { navigationFixture } from "./producer-fixture.ts";
export function detailFixture() {
  const navigation = structuredClone(navigationFixture);
  const first = navigation.evidence.stops[0];
  if (!first) throw Error("Producer fixture requires one stop");
  const second = structuredClone(first);
  second.route_stop_id = "a4000000-0000-4000-8000-000000000002";
  second.property_id = "a1000000-0000-4000-8000-000000000002";
  second.route_sequence = 2;
  second.route_label = "B";
  second.position.latitude = 30.422;
  navigation.evidence.stops.push(second);
  navigation.evidence.as_of = new Date().toISOString();
  navigation.evidence.promotion.component_registry_version = COMPONENT_VERSION;
  Object.assign(
    navigation.evidence.promotion.required_checks,
    Object.fromEntries(
      [
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
      ].map((key) => [key, true]),
    ),
  );
  const stops = navigation.evidence.stops.map((stop) => ({
    id: stop.route_stop_id,
    property_id: stop.property_id,
    route_sequence: stop.route_sequence,
    route_label: stop.route_label,
    stop_state: "active",
    property_name: "Synthetic entrance",
    property_address: "100 Example Way",
    dwell_minutes: 20,
    buffer_minutes: 10,
    locked_appointment: false,
  }));
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Synthetic entrance tour",
    status: "draft",
    stops,
    route_version_id: navigation.evidence.route_version_id,
    route_version_state: "accepted",
    accepted_route_version: 1,
    routes: [{ id: navigation.evidence.route_version_id, route_version: 1, accepted: true, navigation, stops }],
  };
}

type ParityFixture = {
  projection_id: string;
  component_registry_version?: string;
  canonical_dataset_version?: string;
  routes: {
    accepted: boolean;
    id: string;
    route_version: number;
    navigation?: ReturnType<typeof detailFixture>["routes"][number]["navigation"];
    stops: {
      id: string;
      property_id: string;
      route_sequence: number;
      route_label: string;
      position: { latitude: number; longitude: number };
    }[];
  }[];
};

export function bindParityNavigation(fixture: ParityFixture) {
  const route = fixture.routes.find((route) => route.accepted);
  if (!route) throw Error("Parity fixture requires an accepted route");
  const navigation = detailFixture().routes[0]?.navigation;
  const template = navigation?.evidence.stops[0];
  if (!navigation || !template) throw Error("Parity fixture requires navigation evidence with one stop");
  Object.assign(navigation.evidence, {
    route_version_id: route.id,
    route_version: route.route_version,
    projection_id: fixture.projection_id,
    stops: route.stops.map((stop) => ({
      ...structuredClone(template),
      route_stop_id: stop.id,
      property_id: stop.property_id,
      route_sequence: stop.route_sequence,
      route_label: stop.route_label,
      position: { latitude: stop.position.latitude, longitude: stop.position.longitude },
    })),
  });
  navigation.evidence.promotion.route_version = route.route_version;
  fixture.component_registry_version = navigation.evidence.promotion.component_registry_version;
  fixture.canonical_dataset_version = navigation.evidence.promotion.canonical_dataset_version;
  route.navigation = navigation;
}
