import assert from "node:assert/strict";
import test from "node:test";
import { packetMapPoints, parsePublicTourPacket } from "../src/ui/public-tour-packet.ts";
import { presentedPacket } from "./packet-presentation.fixture.ts";

const stops = [3, 1, 2].map((n) => ({
  property_ref: `property:public:synthetic_stop_000${n}`,
  route_sequence: n,
  route_label: String(n),
  name: `Property ${n}`,
  address: `${n} Example Street`,
  size: { value: 1200, unit: "SF", secret: "PRIVATE" },
  broker_notes: "PRIVATE",
}));
const points = stops.map((stop) => ({ ...stop, latitude: 30, longitude: -87 }));
test("three properties have one canonical order for web, map and print", () => {
  const packet = parsePublicTourPacket(presentedPacket(stops));
  assert.deepEqual(
    packet.map((stop) => stop.name),
    ["Property 1", "Property 2", "Property 3"],
  );
  assert.deepEqual(
    packetMapPoints(packet, { points }).map((point) => point.property_ref),
    packet.map((stop) => stop.property_ref),
  );
  assert.ok(packet.every((stop) => stop.facts.find((fact) => fact.label === "Parking")?.value === "Unknown"));
  assert.ok(packet.every((stop) => stop.facts.find((fact) => fact.label === "Size")?.value === "1200 SF"));
  assert.ok(!JSON.stringify(packet).includes("PRIVATE"));
});
test("map omissions, extras, changed labels and duplicate stop identities refuse the whole packet", () => {
  const packet = parsePublicTourPacket(presentedPacket(stops));
  for (const bad of [points.slice(1), [...points, points[0]], points.map((p) => ({ ...p, route_label: "X" }))]) {
    assert.throws(() => packetMapPoints(packet, { points: bad }));
  }
  assert.throws(() => parsePublicTourPacket({ stops: [stops[0], stops[0]] }));
  assert.throws(() => packetMapPoints(packet, { points: points.map((p) => ({ ...p, latitude: 100 })) }));
});
test("unregistered fallback shapes never become public packet content", () => {
  assert.throws(() => parsePublicTourPacket({ items: stops }));
  assert.throws(() => parsePublicTourPacket({ stops: [] }));
});

test("web refuses absent or incompatible presentation contracts and different property membership", () => {
  assert.throws(() => parsePublicTourPacket({ stops }));
  const wrongVersion = presentedPacket(stops);
  assert.throws(() =>
    parsePublicTourPacket({ ...wrongVersion, presentation: { ...wrongVersion.presentation, version: "3.0.0" } }),
  );
  const omitted = presentedPacket(stops);
  omitted.presentation.stops.pop();
  assert.throws(() => parsePublicTourPacket(omitted));
});

test("web preserves the producer's exact formatted values without a second formatter", () => {
  const wire = presentedPacket(stops);
  const first = wire.presentation.stops[0]?.facts[2];
  assert.ok(first);
  first.value = "USD 20 to 25 SF per year";
  const packet = parsePublicTourPacket(wire);
  assert.equal(
    packet.find((stop) => stop.route_sequence === wire.presentation.stops[0]?.route_sequence)?.facts[2]?.value,
    first.value,
  );
});
