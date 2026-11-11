import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { uiAssets } from "../scripts/ui-bundle.mjs";

test("tracked JavaScript stays visible to Git ignore checks", () => {
  const tracked = execFileSync("git", ["ls-files", "-z", "js/"], { encoding: "utf8" });
  assert.ok(tracked.length > 0);
  const result = spawnSync("git", ["check-ignore", "--no-index", "-v", "-z", "--stdin"], {
    input: tracked,
    encoding: "utf8",
  });
  assert.equal(result.stdout, "");
  assert.equal(result.status, 1);
});

test("fresh UI entry bundles and future shared chunks are ignored", async () => {
  const assets = await uiAssets((path) => readFile(path, "utf8"));
  const paths = [...assets.keys(), "js/ui-shared-ABC12345.generated.js"];
  assert.ok(paths.length > 1);
  const ignored = execFileSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
    input: `${paths.join("\0")}\0`,
    encoding: "utf8",
  });
  assert.deepEqual(ignored.split("\0").filter(Boolean).sort(), paths.sort());
});

test("handwritten UI names stay visible to Git", () => {
  const paths = [
    "js/ui-handwritten.js",
    "js/ui-workspace.js",
    "js/ui-future-screen.js",
    "js/ui-facts-helper.js",
    "js/ui-shared-handwritten.js",
    "js/ui-shared-handwritten.generated.js",
    "js/nested/ui-facts.js",
  ];
  const result = spawnSync("git", ["check-ignore", "--no-index", "-v", "--stdin"], {
    input: paths.join("\n"),
    encoding: "utf8",
  });
  assert.equal(result.stdout, "");
  assert.equal(result.status, 1);
});
