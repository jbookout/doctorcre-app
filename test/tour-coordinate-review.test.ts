import assert from "node:assert/strict";
import test from "node:test";
import {
  coordinateReviewSession,
  entranceReceiptResult,
  parseCoordinateReview,
} from "../src/ui/tour-coordinate-review-model.ts";
import { coordinateDetailFixture } from "./fixtures/coordinate-review/detail.ts";

const binding = { session: "one", tour: "tour", route: "route", property: "property" };
const fixture = () => {
  const r = coordinateDetailFixture().stops[0]?.coordinate_review;
  if (!r) throw Error();
  return r;
};
const input = (r = fixture()) => ({
  idempotency_key: "retained-key",
  property_id: r.property_id,
  coordinate_candidate_id: r.candidates[0]?.coordinate_candidate_id ?? "",
  verified_at: r.as_of,
  evidence_reference: "site",
  receipt_digest: "sha256:" + "a".repeat(64),
  native_navigation_proof: {
    platform: "google_maps",
    tested_at: r.as_of,
    travel_mode: "driving",
    evidence_digest: "sha256:" + "b".repeat(64),
  },
});
test("compare exact candidates without mutations; invalid rights and centroid approval refuse", () => {
  const r = fixture(),
    snapshot = JSON.stringify(r);
  assert.deepEqual(parseCoordinateReview(r, r.property_id), r);
  assert.equal(JSON.stringify(r), snapshot);
  const c = r.candidates[1];
  assert.ok(c);
  c.position = { latitude: 1, longitude: 2 };
  assert.equal(parseCoordinateReview(r, r.property_id), null);
  c.position = null;
  c.approval = {
    status: "verified_entrance",
    receipt: {
      verification_receipt_id: "r",
      verifier_actor_id: "human",
      verified_at: r.as_of,
      evidence_reference: "site",
      native_navigation_proof: {},
      receipt_digest: "digest",
    },
  };
  assert.equal(parseCoordinateReview(r, r.property_id), null);
});
test("refresh, read failure, retry, wrong property and retired late reads", async () => {
  const r = fixture();
  let value: unknown = r;
  let fail = false;
  const s = coordinateReviewSession({ ...binding, property: r.property_id }, r, {
    read: async () => {
      if (fail) throw Error();
      return value;
    },
    write: async () => "confirmed",
    changed() {},
  });
  await s.refresh();
  assert.equal(s.phase, "comparing");
  fail = true;
  await s.refresh();
  assert.equal(s.phase, "unavailable");
  fail = false;
  await s.refresh();
  assert.equal(s.phase, "comparing");
  value = { ...r, property_id: "other" };
  await s.refresh();
  assert.equal(s.review, null);
  let resolve: (v: unknown) => void = () => {};
  const late = coordinateReviewSession({ ...binding, property: r.property_id }, r, {
    read: () =>
      new Promise((r) => {
        resolve = r;
      }),
    write: async () => "confirmed",
    changed() {},
  });
  const pending = late.refresh();
  late.retire();
  resolve(r);
  await pending;
  assert.equal(late.phase, "retired");
  assert.equal(late.review, null);
});
test("review authority refused, exact unknown retry, confirmed refresh and late write retirement", async () => {
  const r = fixture(),
    calls: unknown[] = [];
  let outcome: "refused" | "unknown" | "confirmed" = "refused";
  let reads = 0;
  const s = coordinateReviewSession({ ...binding, property: r.property_id }, r, {
    read: async () => {
      reads++;
      return r;
    },
    write: async (a) => {
      calls.push(a);
      return outcome;
    },
    changed() {},
  });
  await s.submit(input(r));
  assert.equal(s.phase, "refused");
  outcome = "unknown";
  await s.submit(input(r));
  assert.equal(s.phase, "unknown");
  await s.refresh();
  assert.equal(reads, 0);
  outcome = "confirmed";
  await s.resubmit();
  assert.deepEqual(calls[1], calls[2]);
  assert.equal(s.phase, "comparing");
  assert.equal(reads, 1);
  let resolve: (v: "confirmed") => void = () => {};
  const late = coordinateReviewSession({ ...binding, property: r.property_id }, r, {
    read: async () => r,
    write: () =>
      new Promise((r) => {
        resolve = r;
      }),
    changed() {},
  });
  const pending = late.submit(input(r));
  late.retire();
  resolve("confirmed");
  await pending;
  assert.equal(late.phase, "retired");
  assert.equal(late.review, null);
});
test("missing or cross-property evidence refuses", () => {
  assert.equal(parseCoordinateReview(null, "property"), null);
  assert.equal(parseCoordinateReview({ schema: "tour-coordinate-review.v1", property_id: "other" }, "property"), null);
});

test("only explicit human refusals or receipt identities settle a write", () => {
  assert.equal(entranceReceiptResult({ ok: true }, false), "unknown");
  assert.equal(entranceReceiptResult({ error: "internal_error" }, true), "unknown");
  assert.equal(entranceReceiptResult({ error: "tour_human_verification_required" }, true), "refused");
  assert.equal(
    entranceReceiptResult({ ok: true, verification_receipt_id: "11111111-1111-4111-8111-111111111111" }, false),
    "confirmed",
  );
});
test("retirement clears every visible phase and prevents later reads and writes", async () => {
  for (const target of ["comparing", "unavailable", "refused", "unknown", "reading", "reviewing"]) {
    const r = fixture();
    let unblock: () => void = () => {};
    const s = coordinateReviewSession({ ...binding, property: r.property_id }, r, {
      read: async () => {
        if (target === "unavailable") throw Error();
        if (target === "reading")
          await new Promise<void>((resolve) => {
            unblock = resolve;
          });
        return r;
      },
      write: async () => {
        if (target === "reviewing")
          await new Promise<void>((resolve) => {
            unblock = resolve;
          });
        return target === "refused" ? "refused" : "unknown";
      },
      changed() {},
    });
    let pending = Promise.resolve();
    if (["reading", "unavailable"].includes(target)) pending = s.refresh();
    if (["reviewing", "refused", "unknown"].includes(target)) pending = s.submit(input(r));
    if (!["reading", "reviewing"].includes(target)) await pending;
    assert.equal(s.phase, target);
    s.retire();
    unblock();
    await pending;
    await s.refresh();
    await s.submit(input(r));
    await s.resubmit();
    assert.equal(s.phase, "retired");
    assert.equal(s.review, null);
  }
});
