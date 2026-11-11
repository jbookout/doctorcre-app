import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { startFixture } from "../scripts/fixture-http.mjs";
import { parseEvidence, prove } from "../scripts/prove-client-links.ts";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";

test("client proof gates equal descendant older unrelated and unknown releases before browser work", async (t) => {
  const cwd = temporaryDirectory("client-proof-git-", t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.test");
  git("commit", "--allow-empty", "-qm", "older");
  const older = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "merge");
  const commit = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "descendant");
  const descendant = git("rev-parse", "HEAD");
  git("checkout", "--orphan", "unrelated");
  git("commit", "--allow-empty", "-qm", "unrelated");
  const unrelated = git("rev-parse", "HEAD");
  for (const observed of [commit, descendant, older, unrelated, "a".repeat(40)]) {
    const server = await startFixture({
      routes: new Map([
        [
          "/app-release",
          {
            contentType: "application/json",
            body: JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: observed }),
          },
        ],
      ]),
    });
    try {
      await assert.rejects(prove({ origin: server.origin, commit, cwd, timeoutMs: 3000 }), (error: unknown) => {
        assert.ok(error instanceof Error && "exitCode" in error);
        assert.equal(error.exitCode, 78);
        assert.equal(
          error.message,
          [commit, descendant].includes(observed)
            ? "Client link evidence required"
            : "Containing release evidence unavailable",
        );
        return true;
      });
    } finally {
      await server.close();
    }
  }
});

test("client proof accepts both displayed link formats and rejects duplicate token aliases", () => {
  const origin = "https://reports.doctorcre.com";
  const value = {
    active: origin + "/share#token=" + "a".repeat(43),
    revoked: origin + "/share#" + "r".repeat(43),
    viewOnly: origin + "/share#token=" + "v".repeat(43),
    rows: [
      { propertyRef: "property:public:synthetic_property_01", label: "A", name: "Clinic", detail: "123 Medical Drive" },
    ],
    pdfSha256: "a".repeat(64),
  };
  assert.equal(new URL(parseEvidence(value, origin).active).hash, "#" + "a".repeat(43));
  assert.throws(() => parseEvidence({ ...value, revoked: origin + "/share#" + "a".repeat(43) }, origin), {
    exitCode: 78,
  });
  for (const hash of ["#token=short", "#token=" + "a".repeat(43) + "&extra=x", "#" + "a".repeat(44)])
    assert.throws(() => parseEvidence({ ...value, active: origin + "/share" + hash }, origin), { exitCode: 78 });
});
