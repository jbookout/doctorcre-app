import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { codeRuleIssues } from "../scripts/client-lint-rules.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";

for (const source of [
  "let x: any;",
  "const x = value!;",
  "enum Kind { A }",
  "namespace Kind {}",
  "class A { constructor(public x: string) {} }",
  "// @ts-ignore\nconst x = value;",
  "// @ts-expect-error\nconst x = value;",
  "const x = value as string;",
]) {
  test(`code rules reject ${source}`, () => assert.notEqual(codeRuleIssues(source).length, 0));
}

test("code rules accept narrowing, const literals and an explained cast", () => {
  assert.deepEqual(codeRuleIssues('const value: unknown = 1; if (typeof value === "number") value.toFixed();'), []);
  assert.deepEqual(codeRuleIssues('const value = {kind: "ready"} as const;'), []);
  assert.deepEqual(
    codeRuleIssues("// The schema checked this value before the call.\nconst value = input as string;"),
    [],
  );
});

test("shared hook injects rules once, reports Biome violations and rejects malformed syntax", (t) => {
  const root = temporaryDirectory("typescript-hook-", t);
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "node_modules"));
  symlinkSync(new URL("../node_modules/.bin", import.meta.url).pathname, join(root, "node_modules/.bin"), "dir");
  copyFileSync(new URL("../biome.json", import.meta.url), join(root, "biome.json"));
  writeFileSync(join(root, "good.ts"), "export const value = 1;\n");
  const script = new URL("../scripts/agent-typescript-hook.ts", import.meta.url).pathname;
  const run = (file: string) =>
    spawnSync(process.execPath, [script, "test-session", file], { cwd: root, encoding: "utf8" });
  const first = run("good.ts");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Use unknown/);
  assert.doesNotMatch(run("good.ts").stdout, /Use unknown/);
  writeFileSync(join(root, "bad.ts"), "export const value:number=1;");
  assert.equal(run("bad.ts").status, 1);
  writeFileSync(join(root, "broken.ts"), "export const = ;");
  assert.equal(run("broken.ts").status, 1);
  writeFileSync(join(root, "floating.ts"), "async function work() {\n  return 1;\n}\nwork();\n");
  const floating = run("floating.ts");
  assert.equal(floating.status, 1);
  assert.match(floating.stderr + floating.stdout, /noFloatingPromises/);
  writeFileSync(join(root, "inferrable.ts"), "export let count: number = 1;\n");
  const inferrable = run("inferrable.ts");
  assert.equal(inferrable.status, 1);
  assert.match(inferrable.stderr + inferrable.stdout, /noInferrableTypes/);
  writeFileSync(join(root, "good file.ts"), "export const value = 1;\n");
  const event = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({ session_id: "../../another-agent", tool_input: { file_path: "good file.ts" } }),
  });
  assert.equal(event.status, 0, event.stderr);
  assert.match(event.stdout, /Use unknown/);
  const empty = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", input: "{}" });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, "");
  const malformed = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", input: "{" });
  assert.equal(malformed.status, 1);
  const javascript = spawnSync(process.execPath, [script, "test-session", "legacy.js"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(javascript.status, 0);
  assert.equal(javascript.stdout, "");
});
