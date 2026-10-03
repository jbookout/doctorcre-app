import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");

test("the production release script refuses off-main and dirty checkouts, like staging", () => {
  const source = read("release-production.mjs");
  assert.match(source, /sourceCommit !== mainCommit/);
  assert.match(source, /untracked-files=all/);
  assert.match(source, /production releases require a clean checkout/);
});

test("the production release tags production-<sha12> and stamps the full SHA", () => {
  const source = read("release-production.mjs");
  assert.match(source, /`production-\$\{sourceCommit\.slice\(0, 12\)\}`/);
  assert.match(source, /`GIT_SHA:\$\{sourceCommit\}`/);
});

test("the production release has no first-use deploy fallback and targets the root environment", () => {
  const source = read("release-production.mjs");
  assert.doesNotMatch(source, /"wrangler", "deploy"/);
  assert.doesNotMatch(source, /10007/);
  assert.match(source, /"versions", "upload", "--env", ""/);
  assert.match(source, /"versions", "deploy", `\$\{providerVersionId\}@100%`, "--env", ""/);
});

test("the production rollback deploys one exact prior version at 100% on the root environment", () => {
  const source = read("rollback-production.mjs");
  assert.match(source, /"versions", "deploy", `\$\{versionId\}@100%`, "--env", ""/);
  assert.match(source, /rollback:production -- <exact-version-id>/);
});

// Both release scripts gate on `npm test`. Left unbounded, node --test runs
// availableParallelism()-1 files at once: 17 on the 18-core release host
// against about 3 on a GitHub runner. That many software-GL Chromium files at
// once on a loaded host timed out a different handful of browser tests on 5 of
// 7 app releases (2026-10-02/03) while CI stayed green on the same commits.
test("the release test gate runs at a fixed, CI-sized file concurrency", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const concurrency = Number(/--test-concurrency=(\d+)/.exec(pkg.scripts.test)?.[1]);
  assert.ok(concurrency >= 1 && concurrency <= 3, `npm test must cap file concurrency at 3 or lower: ${pkg.scripts.test}`);
  for (const name of ["release-production.mjs", "release-staging.mjs"]) {
    assert.match(read(name), /run\("npm", \["test"\]\)/, `${name} gates on npm test`);
  }
});
