import { execFileSync } from "node:child_process";

import { credentialFreeEnv } from "./release-environment.mjs";
import { providerRelease } from "./provider-release.mjs";
import { uploadedVersionId } from "./provider-version.mjs";

const run = (command, args, { capture = false } = {}) => execFileSync(command, args, {
  cwd: new URL("../", import.meta.url),
  encoding: "utf8",
  stdio: capture ? "pipe" : "inherit",
  env: credentialFreeEnv(),
});

const sourceCommit = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
const mainCommit = run("git", ["rev-parse", "origin/main"], { capture: true }).trim();
const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { capture: true }).trim();

if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("HEAD is not a full Git commit");
if (sourceCommit !== mainCommit) throw new Error("staging releases must use the exact origin/main commit");
if (status) throw new Error("staging releases require a clean checkout");

// Verification also replaces dist/site from the verified archive, so restored
// workspace/cache output can never become the provider's deployment input.
run("node", ["scripts/build-artifact.mjs", "prepare-deployment"]);
const provider = providerRelease();

const versionTag = `staging-${sourceCommit.slice(0, 12)}`;
const message = `DoctorCRE staging ${sourceCommit}`;
const deploymentStatus = provider(["deployments", "status", "--env", "staging", "--json"], { capture: true, allowFailure: true });
const providerOutput = `${deploymentStatus.stdout || ""}\n${deploymentStatus.stderr || ""}`;
if (deploymentStatus.status === 0) {
  const uploadOutput = provider(["versions", "upload", "--env", "staging", "--strict",
    "--tag", versionTag, "--message", message, "--var", `GIT_SHA:${sourceCommit}`], { capture: true });
  process.stdout.write(uploadOutput);
  const providerVersionId = uploadedVersionId(uploadOutput);
  provider(["versions", "deploy", `${providerVersionId}@100%`, "--env", "staging",
    "--message", message, "--yes"]);
} else if (/code:\s*10007/.test(providerOutput)) {
  provider(["deploy", "--env", "staging", "--strict", "--tag", versionTag,
    "--message", message, "--var", `GIT_SHA:${sourceCommit}`]);
} else {
  throw new Error("could not establish the current DoctorCRE staging deployment state");
}
provider(["deployments", "status", "--env", "staging", "--json"]);
