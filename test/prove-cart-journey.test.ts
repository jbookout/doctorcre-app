import assert from "node:assert/strict";
import test from "node:test";
import { compareJourney, proveJourney } from "../scripts/prove-cart-journey.ts";

test("cart journey proof requires exact identities and permits changed route order", async () => {
  compareJourney(["a"], ["b", "a"], ["a", "b"]);
  compareJourney(["a", "b"], ["a"], ["a"], ["a"]);
  assert.throws(() => compareJourney(["a"], ["b"], ["b"], ["b"]));
  assert.throws(() => compareJourney(["a"], ["a"], ["ab"]));
  assert.throws(() => compareJourney(["a"], ["ab"], ["ab"]));
  assert.throws(() => compareJourney([], [], []));
  assert.throws(() => compareJourney(["a"], ["a"], ["a", "a"]));
  const options = { origin: "https://app.doctorcre.com", expectedCommit: "a".repeat(40) };
  assert.equal((await proveJourney({ ...options, fixtureCase: "pass" })).exitCode, 0);
  assert.equal((await proveJourney({ ...options, fixtureCase: "fail" })).exitCode, 1);
  assert.equal((await proveJourney({ ...options, expectedCommit: "", fixtureCase: "pass" })).exitCode, 78);
});
