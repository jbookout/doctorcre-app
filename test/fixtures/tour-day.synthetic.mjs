export const tourId = "11111111-1111-4111-8111-111111111111";
export const detail = {
  id: tourId, name: "Synthetic tour", status: "scheduled", subject_type: "client", subject_id: "22222222-2222-4222-8222-222222222222",
  routes: [{ id: "33333333-3333-4333-8333-333333333333", accepted: true, route_version: 1,
    stops: [
      { id: "44444444-4444-4444-8444-444444444444", property_id: "55555555-5555-4555-8555-555555555555", route_sequence: 1, route_label: "A", stop_state: "active", property_name: "Demo waterfront office", property_address: "100 Example Way · Suite 200", contact_name: "Demo listing contact", contact_phone: "+1 202 555 0100", access_notes: "West entrance · Visitor parking by the blue awning.", dwell_minutes: 30, buffer_minutes: 10,
        position: { latitude: 30.6001, longitude: -88.0001, coordinate_role: "entrance", precision_class: "entrance", review_state: "reviewed", human_approved: true } },
      { id: "66666666-6666-4666-8666-666666666666", property_id: "77777777-7777-4777-8777-777777777777", route_sequence: 2, route_label: "B", stop_state: "active", property_name: "Demo garden suites", property_address: "200 Example Way", contact_name: "Demo property contact", contact_phone: "+1 202 555 0101", access_notes: "Meet at the north lobby.", dwell_minutes: 20, buffer_minutes: 10,
        position: { latitude: 30.6102, longitude: -88.0102, coordinate_role: "entrance", precision_class: "entrance", review_state: "reviewed", human_approved: true } },
    ] }],
};
detail.stops = detail.routes[0].stops;
