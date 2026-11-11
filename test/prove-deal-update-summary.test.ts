import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const [fixture, exit] of [
  ["pass", 0],
  ["fail", 1],
] as const)
  test(`summary proof CLI ${fixture} fixture has exact comparison`, () => {
    const run = spawnSync(
      process.execPath,
      [
        "scripts/prove-deal-update-summary.ts",
        "--origin",
        "http://localhost",
        "--expected-commit",
        "1".repeat(40),
        "--fixture-case",
        fixture,
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, exit, run.stderr);
    assert.equal(JSON.parse(run.stdout).exitCode, exit);
  });
test("synthetic fixture cannot certify a production origin", () => {
  const run = spawnSync(
    process.execPath,
    [
      "scripts/prove-deal-update-summary.ts",
      "--origin",
      "https://app.doctorcre.com",
      "--expected-commit",
      "1".repeat(40),
      "--fixture-case",
      "pass",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 78, run.stderr);
  assert.equal(JSON.parse(run.stdout).exitCode, 78);
});
