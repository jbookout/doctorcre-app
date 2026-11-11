import assert from "node:assert/strict";
import test from "node:test";
import { EVIDENCE_TTL_MS, navigationFromEvidence } from "../src/ui/tour-navigation.ts";
import { detailFixture } from "./fixtures/tour-navigation/detail.ts";

const detail = detailFixture();
const route = detail.routes[0];
assert.ok(route);
const first = route.stops[0];
assert.ok(first);
test("matching reviewed detail exposes exact entrance coordinates", () => {
  const parsed = navigationFromEvidence(detail.id, route, route.navigation);
  assert.equal(parsed?.positions.get(first.id)?.latitude, 30.421);
  assert.equal(parsed?.positions.get(first.id)?.longitude, -87.216);
});
test("absent unknown stale route projection receipt and component evidence hide navigation", () => {
  const cases: unknown[] = [null, {}, { ...route.navigation, contract_version: "future" }];
  for (const field of [
    "route_version_id",
    "route_version",
    "projection_id",
    "projection_digest",
    "projection_version",
    "as_of",
  ]) {
    cases.push({ ...route.navigation, evidence: { ...route.navigation.evidence, [field]: null } });
  }
  for (const field of [
    "receipt_id",
    "receipt_digest",
    "route_version",
    "component_registry_version",
    "required_checks",
  ]) {
    cases.push({
      ...route.navigation,
      evidence: { ...route.navigation.evidence, promotion: { ...route.navigation.evidence.promotion, [field]: null } },
    });
  }
  for (const candidate of cases) assert.equal(navigationFromEvidence(detail.id, route, candidate), null);
  assert.equal(navigationFromEvidence(detail.id, route, route.navigation, Date.now() + EVIDENCE_TTL_MS), null);
});
