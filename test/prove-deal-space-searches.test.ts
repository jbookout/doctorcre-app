import assert from "node:assert/strict";
import test from "node:test";
import { proveSearch } from "../scripts/prove-deal-space-searches.ts";

test("saved-search proof accepts exact criteria and result IDs and rejects a near miss", async () => {
  const options = { origin: "https://app.doctorcre.com", expectedCommit: "a".repeat(40) };
  assert.equal((await proveSearch({ ...options, fixtureCase: "pass" })).exitCode, 0);
  assert.equal((await proveSearch({ ...options, fixtureCase: "fail" })).exitCode, 1);
  assert.equal((await proveSearch({ ...options, expectedCommit: "", fixtureCase: "pass" })).exitCode, 78);
});
