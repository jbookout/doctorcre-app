import { execFileSync, spawnSync } from "node:child_process";

import { uploadedVersionId } from "./provider-version.mjs";

const run = (command, args, { capture = false, ...options } = {}) => execFileSync(command, args, {
  cwd: new URL("../", import.meta.url),
  encoding: "utf8",
  stdio: capture ? "pipe" : "inherit",
  ...options,
});

const sourceCommit = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
const mainCommit = run("git", ["rev-parse", "origin/main"], { capture: true }).trim();
const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { capture: true }).trim();

if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("HEAD is not a full Git commit");
if (sourceCommit !== mainCommit) throw new Error("staging releases must use the exact origin/main commit");
if (status) throw new Error("staging releases require a clean checkout");

run("npm", ["run", "check"]);
run("npm", ["test"]);
run("npm", ["run", "build"], { env: { ...process.env, DOCTORCRE_SOURCE_COMMIT: sourceCommit } });
run("npm", ["run", "artifact:verify"]);

const versionTag = `staging-${sourceCommit.slice(0, 12)}`;
const message = `DoctorCRE staging ${sourceCommit}`;
const deploymentStatus = spawnSync("npx", ["wrangler", "deployments", "status", "--env", "staging", "--json"], {
  cwd: new URL("../", import.meta.url), encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
});
const providerOutput = `${deploymentStatus.stdout || ""}\n${deploymentStatus.stderr || ""}`;
if (deploymentStatus.status === 0) {
  const uploadOutput = run("npx", ["wrangler", "versions", "upload", "--env", "staging", "--strict",
    "--tag", versionTag, "--message", message, "--var", `GIT_SHA:${sourceCommit}`], { capture: true });
  process.stdout.write(uploadOutput);
  const providerVersionId = uploadedVersionId(uploadOutput);
  run("npx", ["wrangler", "versions", "deploy", `${providerVersionId}@100%`, "--env", "staging",
    "--message", message, "--yes"]);
} else if (/code:\s*10007/.test(providerOutput)) {
  run("npx", ["wrangler", "deploy", "--env", "staging", "--strict", "--tag", versionTag,
    "--message", message, "--var", `GIT_SHA:${sourceCommit}`]);
} else {
  throw new Error("could not establish the current DoctorCRE staging deployment state");
}
run("npx", ["wrangler", "deployments", "status", "--env", "staging", "--json"]);
