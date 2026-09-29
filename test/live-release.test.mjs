import { test } from "node:test";
import assert from "node:assert/strict";

import { waitForLiveRelease } from "../scripts/live-release.mjs";

const sha = "8fc25d969f8cc564ab44d7425a53ae74f027d063";

test("waits for the exact production SHA after an older edge response", async () => {
  const seen = [];
  const replies = [
    { source_commit: "2dd0f5d2d306006a5a57fc58caa2861955be715a", environment: "production" },
    { source_commit: sha, environment: "production", provider_version_id: "version-new" },
  ];
  const result = await waitForLiveRelease({
    expectedSha: sha,
    read: async () => replies.shift(),
    wait: async (ms) => seen.push(ms),
    attempts: 3,
    intervalMs: 5,
  });
  assert.equal(result.source_commit, sha);
  assert.deepEqual(seen, [5]);
});

test("refuses the same SHA from a non-production environment", async () => {
  await assert.rejects(waitForLiveRelease({
    expectedSha: sha,
    read: async () => ({ source_commit: sha, environment: "staging" }),
    wait: async () => {},
    attempts: 2,
    intervalMs: 1,
  }), /environment=staging/);
});

test("a transient read error is retried and the last observed identity is reported", async () => {
  let reads = 0;
  await assert.rejects(waitForLiveRelease({
    expectedSha: sha,
    read: async () => {
      reads += 1;
      if (reads === 1) throw new Error("edge timeout");
      return { source_commit: "older", environment: "production" };
    },
    wait: async () => {},
    attempts: 2,
    intervalMs: 1,
  }), /source_commit=older/);
  assert.equal(reads, 2);
});
