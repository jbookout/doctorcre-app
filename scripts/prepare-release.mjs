import { execFileSync } from "node:child_process";
import { credentialFreeEnv } from "./release-environment.mjs";

const cwd = new URL("../", import.meta.url);
const env = credentialFreeEnv();
const git = args => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const sourceCommit = git(["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(sourceCommit) || sourceCommit !== git(["rev-parse", "origin/main"])) throw new Error("release preparation requires exact origin/main");
if (git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("release preparation requires a clean checkout");
for (const args of [["run", "check"], ["test"], ["run", "build"], ["run", "artifact:verify"]]) {
  execFileSync("npm", args, { cwd, env: { ...env, DOCTORCRE_SOURCE_COMMIT: sourceCommit }, stdio: "inherit" });
}
