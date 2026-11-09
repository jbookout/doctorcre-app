import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function object(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

test("each staged project inherits every standard strict flag", () => {
  const base = object("tsconfig.base.json");
  assert.ok(typeof base.compilerOptions === "object" && base.compilerOptions !== null);
  const flags = Object.fromEntries(Object.entries(base.compilerOptions));
  for (const flag of [
    "strict",
    "noEmit",
    "allowImportingTsExtensions",
    "erasableSyntaxOnly",
    "verbatimModuleSyntax",
    "noUncheckedIndexedAccess",
    "noUnusedLocals",
    "noUnusedParameters",
    "exactOptionalPropertyTypes",
  ]) {
    assert.equal(flags[flag], true, flag);
  }
  assert.equal(flags.target, "esnext");
  assert.equal(flags.module, "nodenext");
  assert.deepEqual(flags.types, ["node"]);
  for (const path of ["tsconfig.browser.json", "tsconfig.node.json", "tsconfig.worker.json"]) {
    const config = object(path);
    assert.equal(config.extends, "./tsconfig.base.json");
    if (config.compilerOptions !== undefined) {
      assert.ok(typeof config.compilerOptions === "object" && config.compilerOptions !== null);
      for (const [key, value] of Object.entries(config.compilerOptions)) {
        if (flags[key] === true) assert.equal(value, true, `${path} ${key}`);
      }
    }
  }
});

test("the check keeps Knip unconditional, dependencies exact and Node 26 mandatory", () => {
  const pkg = object("package.json");
  assert.ok(typeof pkg.scripts === "object" && pkg.scripts !== null && "check" in pkg.scripts);
  assert.ok(typeof pkg.scripts.check === "string");
  assert.match(pkg.scripts.check, / && knip && /);
  assert.ok(typeof pkg.engines === "object" && pkg.engines !== null && "node" in pkg.engines);
  assert.equal(pkg.engines.node, ">=26");
  for (const section of [pkg.dependencies, pkg.devDependencies]) {
    if (section === undefined) continue;
    assert.ok(typeof section === "object" && section !== null);
    for (const version of Object.values(section)) assert.match(String(version), /^\d+\.\d+\.\d+$/);
  }
  assert.equal("lint" in pkg.scripts, false);
});

test("Knip excludes only named vendor source and has no diagnostic suppression lists", () => {
  const config = object("knip.json");
  assert.deepEqual(Object.keys(config).sort(), ["entry", "paths", "project"]);
  assert.ok(Array.isArray(config.project));
  const scope = object("scripts/typescript-migration.json");
  assert.ok(Array.isArray(scope.vendorExceptions));
  assert.deepEqual(
    config.project.filter((value) => typeof value === "string" && value.startsWith("!")),
    scope.vendorExceptions.map((value) => `!${String(value)}`),
  );
});
