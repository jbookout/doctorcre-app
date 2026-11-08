import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { unexpectedJavaScript } from "../scripts/check-javascript.ts";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";

const vendorExceptions = ["reports", "tours"].flatMap((area) =>
  ["maplibre-gl", "maplibre-gl-shared", "maplibre-gl-worker"].map(
    (name) => `${area}/vendor/maplibre-gl-6.4.1/${name}.mjs`,
  ),
);
const allowed = { vendorExceptions, legacyJavaScript: ["scripts/legacy.mjs"] };

test("repository configuration names exactly the six vendor exceptions", () => {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../scripts/typescript-migration.json", import.meta.url), "utf8"),
  );
  assert.ok(typeof value === "object" && value !== null && "vendorExceptions" in value);
  assert.deepEqual(value.vendorExceptions, vendorExceptions);
});

test("only the six named MapLibre paths and inventoried legacy JavaScript pass", () => {
  assert.deepEqual(unexpectedJavaScript([...vendorExceptions, "scripts/legacy.mjs", "src/new.ts"], allowed), []);
});

for (const path of [
  "src/new.js",
  "scripts/new.mjs",
  "test/new.cjs",
  "src/new.jsx",
  "tours/vendor/maplibre-gl-6.4.1/lookalike.mjs",
  "tours/vendor/tour-map-route-state.js",
  "other/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs",
]) {
  test(`rejects ${path}`, () => assert.deepEqual(unexpectedJavaScript([path], allowed), [path]));
}

test("CLI catches untracked and tracked JavaScript without historical git objects", (t) => {
  const directory = temporaryDirectory("javascript-gate-", t);
  execFileSync("git", ["init", "-q", directory]);
  const script = new URL("../scripts/check-javascript.ts", import.meta.url);
  assert.equal(spawnSync(process.execPath, [script.pathname], { cwd: directory }).status, 0);
  writeFileSync(join(directory, "new.mjs"), "export {};");
  for (const tracked of [false, true]) {
    if (tracked) execFileSync("git", ["add", "new.mjs"], { cwd: directory });
    const result = spawnSync(process.execPath, [script.pathname], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /new\.mjs/);
  }
  writeFileSync(join(directory, "new.ts"), "export const value = 1;");
  const typed = spawnSync(process.execPath, [script.pathname], { cwd: directory, encoding: "utf8" });
  assert.equal(typed.status, 1);
  assert.match(typed.stderr, /new\.ts must join a strict tsconfig/);
});
