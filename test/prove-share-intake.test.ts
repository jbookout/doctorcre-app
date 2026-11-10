import assert from "node:assert/strict";
import test from "node:test";
import { proveShare } from "../scripts/prove-share-intake.ts";

for (const [fixtureCase, exitCode] of [
  ["pass", 0],
  ["fail", 1],
  ["insufficient", 78],
] as const) {
  test(`release-aware share proof fixture ${fixtureCase}`, async () => {
    const result = await proveShare({
      origin: "https://app.doctorcre.com",
      expectedCommit: "a".repeat(40),
      fixtureCase,
    });
    assert.equal(result.exitCode, exitCode);
  });
}
