import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeRuleIssues } from "./client-lint-rules.mjs";

const rules =
  "Use unknown and narrow it. No any, suppression directives, non-null assertions, enum, namespace, or parameter properties. Validate external data. A needed cast gets an adjacent one-line why. Comments explain only a hidden why. Pin exact dependencies.";
const args = process.argv.slice(2);
if (args.length === 0) {
  const event: unknown = JSON.parse(readFileSync(0, "utf8"));
  if (typeof event !== "object" || event === null) throw Error("Invalid edit event");
  if (!("tool_input" in event) || typeof event.tool_input !== "object" || event.tool_input === null) process.exit(0);
  const input = event.tool_input;
  if (!("file_path" in input) || typeof input.file_path !== "string") process.exit(0);
  if (!("session_id" in event) || typeof event.session_id !== "string") throw Error("Edit event requires session_id");
  args.push(event.session_id, input.file_path);
}
const session = args.shift();
if (!session || args.length === 0) throw Error("Usage: node scripts/agent-typescript-hook.ts SESSION FILE...");
const files = args.filter((path) => /\.[cm]?tsx?$/.test(path));
if (files.length) {
  const digest = createHash("sha256").update(session).digest("hex");
  const state = execFileSync("git", ["rev-parse", "--git-path", `typescript-hook-${digest}`], {
    encoding: "utf8",
  }).trim();
  try {
    writeFileSync(state, "", { flag: "wx" });
    process.stdout.write(`${rules}\n`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  for (const file of files) {
    for (const issue of codeRuleIssues(readFileSync(file, "utf8"))) {
      process.stderr.write(`${file}: ${issue}\n`);
      process.exitCode = 1;
    }
  }
  const result = spawnSync(resolve("node_modules/.bin/biome"), ["check", "--error-on-warnings", ...files], {
    stdio: "inherit",
    timeout: 120_000,
  });
  if (result.status !== 0) process.exitCode = 1;
}
