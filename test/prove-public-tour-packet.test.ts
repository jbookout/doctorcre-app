import assert from "node:assert/strict";
import test from "node:test";
import { proveTourPacket } from "../scripts/prove-public-tour-packet.ts";

for (const [fixtureCase, exitCode] of [
  ["pass", 0],
  ["fail", 1],
  ["insufficient", 78],
] as const)
  test(`packet proof ${fixtureCase} fixture`, async () => {
    const result = await proveTourPacket({
      origin: "https://app.doctorcre.com",
      expectedCommit: "1".repeat(40),
      fixtureCase,
    });
    assert.equal(result.exitCode, exitCode);
  });
