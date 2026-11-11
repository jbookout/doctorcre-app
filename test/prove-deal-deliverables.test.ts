import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { proveDeliverables } from "../scripts/prove-deal-deliverables.ts";

const fixture = JSON.parse(
  await readFile(new URL("../contracts/fixtures/deal-document-intake.v1.json", import.meta.url), "utf8"),
);
for (const [fixtureCase, exitCode] of [
  ["pass", 0],
  ["fail", 1],
  ["insufficient", 78],
] as const)
  test(`deliverable proof ${fixtureCase} has exact exit classification`, async () => {
    const result = await proveDeliverables({
      origin: "http://127.0.0.1",
      expectedCommit: "1".repeat(40),
      dealId: fixture.finalize.deliverable.deal_id,
      expected: fixture.finalize.deliverable,
      fixtureCase,
    });
    assert.equal(result.exitCode, exitCode);
  });
