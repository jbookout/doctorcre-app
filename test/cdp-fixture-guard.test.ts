import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { cdpFixtureViolations } from "../scripts/check-cdp-fixtures.ts";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { rawReadCorpus } from "./cdp-negative-corpus.ts";

for (const source of rawReadCorpus)
  test(`CDP guard refuses ${source}`, () => {
    assert.ok(cdpFixtureViolations(source, "test/new.browser.ts").length > 0);
  });

test("CDP guard mutation fails and passes after removal in a history-free repository", (t) => {
  const root = temporaryDirectory("cdp-guard-mutation-", t);
  execFileSync("git", ["init", "-q", root]);
  const guard = new URL("../scripts/check-cdp-fixtures.ts", import.meta.url);
  for (const source of rawReadCorpus) {
    writeFileSync(`${root}/mutant.ts`, source);
    const mutated = spawnSync(process.execPath, [guard.pathname], { cwd: root, encoding: "utf8" });
    assert.equal(mutated.status, 1, mutated.stderr);
    rmSync(`${root}/mutant.ts`);
    const clean = spawnSync(process.execPath, [guard.pathname], { cwd: root, encoding: "utf8" });
    assert.equal(clean.status, 0, clean.stderr);
  }
});

test("CDP guard respects unrelated lexical shadowing", () => {
  assert.deepEqual(
    cdpFixtureViolations(
      'const left="other"; function unrelated(){const left="DevTools";} readFile(left+"ActivePort");',
      "test/new.browser.ts",
    ),
    [],
  );
});
