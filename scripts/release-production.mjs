// Production release: the same audited path as release-staging.mjs, pointed at
// the production environment. Production already exists, so there is no
// first-use `deploy` fallback here on purpose: a missing production Worker is
// a refusal, never a creation. The hostname attachment (app.doctorcre.com)
// lives outside this script and outside wrangler.jsonc.
//
// Run only from a clean checkout at exactly origin/main, under Joe's explicit
// instruction for that release. `versions deploy ... @100%` is the one
// irreversible step; undo it with `npm run rollback:production -- <id>`.
import { execFileSync, spawnSync } from "node:child_process";

import { credentialFreeEnv } from "./release-environment.mjs";
import { uploadedVersionId } from "./provider-version.mjs";

const run = (command, args, { capture = false, ...options } = {}) => execFileSync(command, args, {
  cwd: new URL("../", import.meta.url),
  encoding: "utf8",
  stdio: capture ? "pipe" : "inherit",
  env: command === "npx" ? { ...credentialFreeEnv(), CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN } : credentialFreeEnv(),
  ...options,
});

const sourceCommit = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
const mainCommit = run("git", ["rev-parse", "origin/main"], { capture: true }).trim();
const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { capture: true }).trim();

if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("HEAD is not a full Git commit");
if (sourceCommit !== mainCommit) throw new Error("production releases must use the exact origin/main commit");
if (status) throw new Error("production releases require a clean checkout");

// Verification also replaces dist/site from the verified archive, so restored
// workspace/cache output can never become the provider's deployment input.
run("node", ["scripts/build-artifact.mjs", "prepare-deployment"], { env: credentialFreeEnv() });
if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("publication requires CLOUDFLARE_API_TOKEN");

// The tag mirrors the live convention: production- plus the first 12 characters
// of the full SHA, which is what /app-release reports back.
const versionTag = `production-${sourceCommit.slice(0, 12)}`;
const message = `DoctorCRE production ${sourceCommit}`;
const deploymentStatus = spawnSync("npx", ["--no-install", "wrangler", "deployments", "status", "--env", "", "--json"], {
  cwd: new URL("../", import.meta.url), encoding: "utf8", env: { ...credentialFreeEnv(), CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, NO_COLOR: "1" },
});
if (deploymentStatus.status !== 0) {
  throw new Error("could not establish the current DoctorCRE production deployment state");
}
const uploadOutput = run("npx", ["--no-install", "wrangler", "versions", "upload", "--env", "", "--strict",
  "--tag", versionTag, "--message", message, "--var", `GIT_SHA:${sourceCommit}`], { capture: true });
process.stdout.write(uploadOutput);
const providerVersionId = uploadedVersionId(uploadOutput);
run("npx", ["--no-install", "wrangler", "versions", "deploy", `${providerVersionId}@100%`, "--env", "",
  "--message", message, "--yes"]);
run("npx", ["--no-install", "wrangler", "deployments", "status", "--env", "", "--json"]);
