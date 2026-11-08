import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const files = new Set<string>();
for (const config of ["tsconfig.base.json", "tsconfig.browser.json", "tsconfig.node.json"]) {
  const result = spawnSync(resolve("node_modules/.bin/tsc"), ["-p", config], { stdio: "inherit", timeout: 120_000 });
  if (result.status !== 0) process.exit(1);
  const value: unknown = JSON.parse(readFileSync(config, "utf8"));
  assert.ok(typeof value === "object" && value !== null && "files" in value && Array.isArray(value.files));
  for (const file of value.files) {
    assert.ok(typeof file === "string");
    files.add(file);
  }
}
const hook = spawnSync(process.execPath, ["scripts/agent-typescript-hook.ts", "npm-check", ...files], {
  stdio: "inherit",
  timeout: 120_000,
});
if (hook.status !== 0) process.exit(1);
