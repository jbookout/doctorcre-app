import assert from "node:assert/strict";
import test from "node:test";
import { strictProjectFiles } from "../scripts/strict-projects.ts";

test("new browser and script sources join strict projects without registration", () => {
  const files = strictProjectFiles(["src/ui/one.ts", "src/ui/two.tsx", "scripts/one.ts", "scripts/two.ts"], new Set());
  assert.deepEqual(files.browser, ["src/ui/one.ts", "src/ui/two.tsx"]);
  assert.deepEqual(files.node, ["scripts/one.ts", "scripts/two.ts"]);
});

test("frozen migration files and worker sources retain their separate projects", () => {
  const files = strictProjectFiles(
    ["src/ui/legacy.ts", "src/ui/worker/service-worker.ts", "scripts/legacy.ts", "scripts/types.d.mts", "js/old.js"],
    new Set(["src/ui/legacy.ts", "scripts/legacy.ts"]),
  );
  assert.deepEqual(files.browser, []);
  assert.deepEqual(files.node, ["scripts/types.d.mts"]);
});
