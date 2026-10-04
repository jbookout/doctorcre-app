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

test("releases run main's checks and leave the full suite to the strict PR gate", () => {
  for (const name of ["release-staging.mjs", "release-production.mjs"]) {
    const source = read(name);
    assert.doesNotMatch(source, /run\("npm", \["test"\]\)/, name);
    const checks = source.indexOf('run("npm", ["run", "test:main"]);');
    assert.ok(checks >= 0 && checks < source.indexOf('run("npm", ["run", "build"]'), name);
  }
});
