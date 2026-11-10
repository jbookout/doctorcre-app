import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { temporaryDirectory } from "./temp-directory.mjs";

const repository = process.argv[2] ?? pathToFileURL(resolve(".")).href;
const branch = process.argv[3] ?? execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
const directory = temporaryDirectory("shared-project-clean-checkout-");
try {
  execFileSync("git", ["clone", "--depth", "1", "--branch", branch, repository, directory], { stdio: "inherit" });
  execFileSync("npm", ["ci"], { cwd: directory, stdio: "inherit" });
  assert.equal(existsSync(resolve(directory, "out")), false, "Fresh clone must have no out directory");
  execFileSync("npm", ["run", "check:shared-lists"], {
    cwd: directory,
    stdio: "inherit",
    timeout: 600_000,
  });
  console.log("Fresh shallow clone passed check:shared-lists without out/");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
