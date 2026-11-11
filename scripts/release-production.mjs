// Production release: the same audited path as release-staging.mjs, pointed at
// the production environment. Production already exists, so there is no
// first-use `deploy` fallback here on purpose: a missing production Worker is
// a refusal, never a creation. The hostname attachment (app.doctorcre.com)
// lives outside this script and outside wrangler.jsonc.
//
// Run only from a clean checkout at exactly origin/main, under Joe's explicit
// instruction for that release. `versions deploy ... @100%` is the one
// irreversible step; undo it with `npm run rollback:production -- <id>`.
import { appendFileSync } from "node:fs";
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

const receipt = (disposition, providerVersionId) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `disposition=${disposition}\nprovider_version_id=${providerVersionId}\npublication_observed_at=${new Date().toISOString()}\n`);
};

const sourceCommit = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
const mainCommit = run("git", ["rev-parse", "origin/main"], { capture: true }).trim();
const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { capture: true }).trim();

if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("HEAD is not a full Git commit");
if (sourceCommit !== mainCommit) throw new Error("production releases must use the exact origin/main commit");
if (status) throw new Error("production releases require a clean checkout");

// Verification also replaces dist/site from the verified archive, so restored
// workspace/cache output can never become the provider's deployment input.
run("node", ["scripts/build-artifact.mjs", "prepare-deployment"]);
const provider = providerRelease();

// The tag mirrors the live convention: production- plus the first 12 characters
// of the full SHA, which is what /app-release reports back.
const versionTag = `production-${sourceCommit.slice(0, 12)}`;
const message = `DoctorCRE production ${sourceCommit}`;
const deploymentStatus = provider(["deployments", "status", "--env", "", "--json"], { capture: true, allowFailure: true });
if (deploymentStatus.status !== 0) {
  throw new Error("could not establish the current DoctorCRE production deployment state");
}
const deployment = JSON.parse(deploymentStatus.stdout);
if (!Array.isArray(deployment.versions)) throw new Error("invalid production deployment state");
const [active] = deployment.versions;
if (deployment.versions.length === 1 && active.percentage === 100) {
  if (!/^[0-9a-f-]{36}$/i.test(active.version_id)) throw new Error("invalid production version identity");
  const version = JSON.parse(provider(["versions", "view", active.version_id, "--env", "", "--json"], { capture: true }));
  if (version.id !== active.version_id || !Array.isArray(version.resources?.bindings)) throw new Error("invalid production version state");
  const source = version.resources.bindings.find(binding => binding.name === "GIT_SHA" && binding.type === "plain_text");
  if (source?.text === sourceCommit) {
    console.log(`Production already serves source ${sourceCommit}; no publication needed.`);
    receipt("already-live", active.version_id);
    process.exit(0);
  }
}
const uploadOutput = provider(["versions", "upload", "--env", "", "--strict",
  "--tag", versionTag, "--message", message, "--var", `GIT_SHA:${sourceCommit}`], { capture: true });
process.stdout.write(uploadOutput);
const providerVersionId = uploadedVersionId(uploadOutput);
provider(["versions", "deploy", `${providerVersionId}@100%`, "--env", "",
  "--message", message, "--yes"]);
provider(["deployments", "status", "--env", "", "--json"]);

receipt("published", providerVersionId);
