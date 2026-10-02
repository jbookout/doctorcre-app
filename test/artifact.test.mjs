import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildArtifact, runCli, verifyArtifact } from "../scripts/artifact.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const COMMIT = "1".repeat(40);

test("the static artifact rebuild is byte-for-byte reproducible", async () => {
  const first = await mkdtemp(join(tmpdir(), "doctorcre-artifact-a-"));
  const second = await mkdtemp(join(tmpdir(), "doctorcre-artifact-b-"));
  const a = await buildArtifact({ root: ROOT, outDir: first, commit: COMMIT });
  const b = await buildArtifact({ root: ROOT, outDir: second, commit: COMMIT });
  assert.equal(a.archiveSha256, b.archiveSha256);
  assert.deepEqual(a.archive, b.archive);
  assert.equal(a.manifest.files.some((file) => file.path === "js/board-focus.mjs"), true);
  assert.equal(a.manifest.files.some((file) => file.path.startsWith("test/")), false);
  assert.equal(a.manifest.files.some((file) => file.path === "data/board-seed.json"), true);
  assert.deepEqual(await readFile(join(first, "site", "workspace.html")), await readFile(join(ROOT, "workspace.html")));
  assert.deepEqual(await readFile(join(first, "site", "progress-board.html")), await readFile(join(ROOT, "progress-board.html")));
  assert.equal(a.manifest.files.some((file) => file.path === "progress-board.html"), true);
  assert.equal(verifyArtifact(a.archive, a.archiveSha256).manifest.files.some((file) => file.path === "progress-board.html"), true);
});

test("the deployment directory is rebuilt without stale files", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "doctorcre-site-clean-"));
  await buildArtifact({ root: ROOT, outDir, commit: COMMIT });
  await writeFile(join(outDir, "site", "stale-secret.txt"), "must disappear");
  await buildArtifact({ root: ROOT, outDir, commit: COMMIT });
  await assert.rejects(readFile(join(outDir, "site", "stale-secret.txt")), /ENOENT/);
});

test("verification binds every payload file and rejects changed bytes", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "doctorcre-artifact-verify-"));
  const built = await buildArtifact({ root: ROOT, outDir, commit: COMMIT });
  const verified = verifyArtifact(built.archive, built.archiveSha256);
  assert.equal(verified.fileCount, built.manifest.files.length);
  assert.equal(verified.manifest.source_commit, COMMIT);

  const changed = Buffer.from(await readFile(join(outDir, "doctorcre-app.tar")));
  changed[520] ^= 1;
  assert.throws(() => verifyArtifact(changed, built.archiveSha256), /digest mismatch/);

  const badHeader = Buffer.from(built.archive);
  badHeader[0] ^= 1;
  assert.throws(() => verifyArtifact(badHeader), /header checksum/);

  const badTrailer = Buffer.from(built.archive);
  badTrailer[badTrailer.length - 1] = 1;
  assert.throws(() => verifyArtifact(badTrailer), /archive trailer/);
});

async function committedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "doctorcre-source-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git(["clone", "--quiet", "--shared", "--no-hardlinks", ROOT, "."]);
  // Exercise the code under test, including edits not yet committed by the maker.
  for (const path of ["scripts/artifact.mjs", "scripts/build-artifact.mjs"]) await copyFile(join(ROOT, path), join(root, path));
  git(["add", "scripts/artifact.mjs", "scripts/build-artifact.mjs"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "Synthetic verifier fixture"]);
  const commit = git(["rev-parse", "HEAD"]);
  const outDir = join(root, "dist");
  const built = await buildArtifact({ root, outDir, commit });
  return { root, outDir, commit, built };
}

test("CLI verification accepts the exact committed artifact", async (t) => {
  const { root } = await committedFixture(t);
  await runCli(root, ["verify"]);
});

test("one contract path declaration drives both assembly and committed-source verification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "doctorcre-contract-membership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git(["clone", "--quiet", "--shared", "--no-hardlinks", ROOT, "."]);
  for (const path of ["scripts/artifact.mjs", "scripts/build-artifact.mjs"]) await copyFile(join(ROOT, path), join(root, path));
  const contracts = [
    ["carr_interface", "contracts/carr-interface.v1.json", "contracts/synthetic-interface.v1.json"],
    ["route_contract", "contracts/app-routes.v1.json", "contracts/synthetic-routes.v1.json"],
  ];
  let source = await readFile(join(root, "scripts/artifact.mjs"), "utf8");
  for (const [, oldPath, newPath] of contracts) {
    await rename(join(root, oldPath), join(root, newPath));
    // A contract-set change must require editing only its single declaration.
    source = source.replace(oldPath, newPath);
  }
  await writeFile(join(root, "scripts/artifact.mjs"), source);
  git(["add", "scripts/artifact.mjs", "scripts/build-artifact.mjs", ...contracts.flatMap(([, oldPath, newPath]) => [oldPath, newPath])]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Synthetic relocated contracts"]);
  for (const command of ["build", "verify"]) {
    execFileSync(process.execPath, ["scripts/build-artifact.mjs", command], {
      cwd: root, env: { ...process.env, DOCTORCRE_SOURCE_COMMIT: "" }, stdio: "pipe",
    });
  }
  const manifest = JSON.parse(await readFile(join(root, "dist", "doctorcre-app.manifest.json")));
  for (const [key, , path] of contracts) assert.equal(manifest[key].path, path);
});

test("publication stops when source bytes change after the build", async (t) => {
  const { root } = await committedFixture(t);
  await writeFile(join(root, "workspace.html"), "Synthetic changed source");
  const marker = join(root, "published");
  assert.throws(() => execFileSync("bash", ["-e", "-c",
    'node scripts/build-artifact.mjs verify\nnode -e \'require("node:fs").writeFileSync("published", "published")\'',
  ], { cwd: root, env: { ...process.env, DOCTORCRE_SOURCE_COMMIT: "" }, stdio: "pipe" }), /source input mismatch/);
  await assert.rejects(readFile(marker), /ENOENT/, "publication never ran");
});

test("a coherently rehashed artifact still must match committed source bytes", async (t) => {
  const { root, outDir, commit } = await committedFixture(t);
  const path = join(root, "workspace.html");
  const original = await readFile(path);
  await writeFile(path, "Synthetic forged payload");
  const forged = await buildArtifact({ root, outDir, commit });
  assert.equal(verifyArtifact(forged.archive, forged.archiveSha256).manifest.source_commit, commit);
  await writeFile(path, original);
  await assert.rejects(runCli(root, ["verify"]), /artifact does not match committed source/);
});

test("a valid-looking source SHA cannot substitute for HEAD", async (t) => {
  const { root, outDir } = await committedFixture(t);
  await buildArtifact({ root, outDir, commit: "f".repeat(40) });
  await assert.rejects(runCli(root, ["verify"]), /source commit mismatch/);
});

test("changed contract source bytes are rejected even when payload bytes are unchanged", async (t) => {
  const { root } = await committedFixture(t);
  const path = join(root, "contracts/carr-interface.v1.json");
  await writeFile(path, `${await readFile(path, "utf8")}\n`);
  await assert.rejects(runCli(root, ["verify"]), /source input mismatch/);
});

test("an untracked artifact input cannot be smuggled into a source-bound build", async (t) => {
  const { root, outDir, commit } = await committedFixture(t);
  await writeFile(join(root, "js", "synthetic-extra.js"), "// synthetic extra input\n");
  await buildArtifact({ root, outDir, commit });
  await assert.rejects(runCli(root, ["verify"]), /source input set mismatch/);
});

test("the external manifest published beside the archive must be identical", async (t) => {
  const { root, outDir, built } = await committedFixture(t);
  await writeFile(join(outDir, "doctorcre-app.manifest.json"), JSON.stringify({ ...built.manifest, source_commit: "f".repeat(40) }));
  await assert.rejects(runCli(root, ["verify"]), /published manifest mismatch/);
});

test("an empty or misnamed digest sidecar cannot turn off digest verification", async (t) => {
  const { root, outDir, built } = await committedFixture(t);
  for (const content of ["", `${built.archiveSha256}  different.tar\n`]) {
    await writeFile(join(outDir, "doctorcre-app.tar.sha256"), content);
    await assert.rejects(runCli(root, ["verify"]), /artifact digest sidecar is invalid/);
  }
});
