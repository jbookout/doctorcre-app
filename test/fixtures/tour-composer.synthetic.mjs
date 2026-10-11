import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
const uuid = () => webcrypto.randomUUID();
const propA = "44444444-4444-4444-8444-444444444444", propB = "55555555-5555-4555-8555-555555555555";
export const properties = [propA, propB].map((property_id, i) => ({ property_id, name: `Synthetic site ${i + 1}`, address: `${100 + i} Example Way`, county: "Escambia", state: "FL" }));
export function response(data, status = 200) { return { ok: status < 400, status, json: async () => status < 400 ? { data, csrf_token: "synthetic-csrf" } : { error: status === 409 ? "conflict" : status === 404 ? "not_found" : "tour_unavailable" } }; }
export function fixtureReviewDigest(route) { return `sha256:${createHash("sha256").update(JSON.stringify({ route_id: route.id, stops: route.stops })).digest("hex")}`; }
export function domain() {
  const tours = new Map(), replay = new Map(), calls = [], transitions = [];
  let fault = null;
  const fetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, body, options });
    if (body) assert.equal(options.headers["x-carr-csrf"], "synthetic-csrf");
    if (path === "/api/tours/library") return response({ tours: [...tours.values()].map(t => ({ id: t.id, name: t.name, status: "draft" })) });
    if (path.startsWith("/api/tours/detail")) {
      if (fault?.path === "/api/tours/detail") { const status = fault.kind === "missing" ? 404 : 503; fault = null; return response(null, status); }
      const tour = tours.get(new URL(path, "https://example.test").searchParams.get("tour_id"));
      if (!tour) return response(null, 404);
      const latest = tour.routes[0], accepted = tour.routes.find(r => r.accepted);
      const reviewed = structuredClone(tour);
      for (const route of reviewed.routes) route.acceptance_digest = fixtureReviewDigest(route);
      return response({ ...reviewed, route_version: accepted?.route_version || 1,
        route_version_id: latest.id, route_version_state: latest.accepted ? "accepted" : "draft",
        accepted_route_version: accepted?.route_version || 0, stops: structuredClone(latest.stops) });
    }
    if (path.startsWith("/api/tours/selection-cart?")) return response(null, 404);
    if (path === "/api/tours/properties/search") return response({ search: { items: properties, has_more: false } });
    if (path.startsWith("/api/tours/property-evidence")) return response({ schema: "tour-property-evidence.v1", facts: {} });
    if (fault?.path === path && fault.kind === "stale") { fault = null; return response(null, 409); }
    if (fault?.path === path && fault.kind === "refused") { fault = null; return response(null, 403); }
    if (replay.has(body?.idempotency_key)) {
      const previous = replay.get(body.idempotency_key);
      return JSON.stringify(body) === previous.body ? response(previous.result) : response(null, 409);
    }
    let result;
    if (path === "/api/tours/create") {
      assert.deepEqual(Object.keys(body).sort(), ["idempotency_key", "tour_name", "subject_type", "subject_id", "canonical_dataset_version", "start_point", "end_point"].sort());
      const id = uuid(); tours.set(id, { id, name: body.tour_name, routes: [{ id: uuid(), route_version: 1, accepted: false, stops: [] }] }); result = { tour_id: id };
    } else if (path === "/api/tours/route-draft") {
      const t = tours.get(body.tour_id), prior = t.routes.find(r => r.accepted);
      if (prior?.id !== body.base_route_version_id || prior.route_version !== body.expected_route_version || body.route_version !== t.routes[0].route_version + 1) return response(null, 409);
      const route = { id: uuid(), route_version: body.route_version, accepted: false, stops: [] }; t.routes.unshift(route); result = { route_version_id: route.id };
    } else if (path === "/api/tours/route-stop") {
      const r = [...tours.values()].flatMap(t => t.routes).find(r => r.id === body.route_version_id);
      if (r.accepted) return response(null, 409);
      if (body.stop_state === "active") {
        assert.ok(Number.isInteger(body.route_sequence) && body.route_sequence > 0);
        assert.match(body.route_label, /^[A-Za-z0-9._ -]{1,80}$/);
        assert.ok(!r.stops.some(s => s.route_sequence === body.route_sequence || s.route_label === body.route_label));
      } else { assert.equal(body.route_sequence, null); assert.equal(body.route_label, null); }
      const stop = { ...body, id: uuid(), name: properties.find(p => p.property_id === body.property_id)?.name }; r.stops.push(stop); result = { route_stop_id: stop.id };
    } else if (path === "/api/tours/route-stop-transition") {
      transitions.push(body); result = { route_stop_transition_id: uuid() };
    } else if (path === "/api/tours/route-accept") {
      const t = [...tours.values()].find(t => t.routes.some(r => r.id === body.route_version_id));
      const r = t.routes.find(r => r.id === body.route_version_id), prior = t.routes.find(r => r.accepted);
      if ((prior?.route_version || 0) !== body.expected_prior_route_version) return response(null, 409);
      assert.equal(body.acceptance_digest, fixtureReviewDigest(r));
      assert.ok(r.stops.some(s => s.stop_state === "active"));
      assert.ok(r.stops.every(s => transitions.some(x => x.new_route_stop_id === s.id && x.new_route_version_id === r.id)));
      if (prior) {
        assert.ok(prior.stops.every(s => transitions.some(x => x.old_route_stop_id === s.id && x.new_route_version_id === r.id)));
        assert.ok(prior.stops.filter(s => s.locked_appointment).every(old => r.stops.some(s => s.property_id === old.property_id && s.stop_state === "active" &&
          ["locked_appointment", "appointment_start", "appointment_end", "dwell_minutes", "buffer_minutes"].every(field => s[field] === old[field]))));
      }
      r.accepted = true; result = { route_version_acceptance_id: uuid() };
    } else throw new Error(`Unexpected path: ${path}`);
    replay.set(body.idempotency_key, { body: JSON.stringify(body), result });
    if (fault?.path === path && fault.kind === "lost") { fault = null; throw new Error("response lost"); }
    return response(result);
  };
  return { tours, calls, transitions, fetch, fail(path, kind) { fault = { path, kind }; } };
}
