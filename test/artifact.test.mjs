import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from './browser-harness.mjs';

import { buildArtifact, runCli, verifyArtifact } from "../scripts/artifact.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const COMMIT = "1".repeat(40);

test('finding 6: emitted public report shell reserves space beside the fixed rail', async t => {
  const outDir=await mkdtemp(join(tmpdir(),'doctorcre-report-layout-'));
  await buildArtifact({root:ROOT,outDir,commit:COMMIT});
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:820,height:900}});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    const name=url.pathname==='/'?'share.html':url.pathname.slice(1);
    try{await route.fulfill({body:await readFile(join(outDir,'site','reports',name)),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});}
    catch{await route.fulfill({status:404,body:''});}
  });
  await page.goto('https://reports.doctorcre.com/');await page.locator('.app-shell-header').waitFor();
  assert.equal(await page.locator('body').evaluate(n=>n.classList.contains('report-shell')),true);
  const rail=await page.locator('.app-shell-header').boundingBox(), main=await page.locator('main').boundingBox();
  assert.ok(main.x>=rail.x+rail.width,`${main.x} clears rail ${rail.x+rail.width}`);
});

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
  assert.deepEqual(await readFile(join(first, "site", "control-room.html")), await readFile(join(ROOT, "control-room.html")));
  assert.equal(a.manifest.files.some((file) => file.path === "control-room.html"), true);
  assert.equal(verifyArtifact(a.archive, a.archiveSha256).manifest.files.some((file) => file.path === "control-room.html"), true);
  assert.deepEqual(await readFile(join(first, "site", "contracts", "lease-radar.v1.json")), await readFile(join(ROOT, "contracts", "lease-radar.v1.json")));
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

test("every contracted page including Doc activity is present in the deployment and archive", async () => {
  const routes = JSON.parse(await readFile(join(ROOT, "contracts/app-routes.v1.json")));
  const outDir = await mkdtemp(join(tmpdir(), "doctorcre-route-artifact-"));
  const built = await buildArtifact({ root: ROOT, outDir, commit: COMMIT });
  const verified = verifyArtifact(built.archive, built.archiveSha256);
  for (const path of new Set(Object.values(routes.routes))) {
    assert.ok(verified.manifest.files.some(file => file.path === path), `missing deployed route: ${path}`);
    assert.deepEqual(await readFile(join(outDir, "site", path)), await readFile(join(ROOT, path)));
  }
});

async function committedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "doctorcre-source-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git(["clone", "--quiet", "--shared", "--no-hardlinks", ROOT, "."]);
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
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
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  for (const path of ["scripts/artifact.mjs", "scripts/build-artifact.mjs"]) await copyFile(join(ROOT, path), join(root, path));
  const contracts = [
    ["carr_interface", "contracts/carr-interface.v1.json", "contracts/synthetic-interface.v1.json"],
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
  await assert.rejects(buildArtifact({ root, outDir, commit }), /file needs a slice owner or shared declaration/);
  const ownershipPath = join(root, 'contracts/slice-ownership.v1.json');
  const ownership = JSON.parse(await readFile(ownershipPath));
  ownership.shared.push('js/synthetic-extra.js');
  await writeFile(ownershipPath, JSON.stringify(ownership));
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


test("slice fragments and generated registry stay bound to committed source", async t => {
  const { root } = await committedFixture(t);
  const fragment = join(root, "contracts/routes/home.json");
  const original = await readFile(fragment, "utf8");
  await writeFile(fragment, original + "\n");
  await assert.rejects(runCli(root, ["verify"]), /source input mismatch/);
  await writeFile(fragment, original);
  const registry = join(root, "js/slices.generated.js");
  await writeFile(registry, (await readFile(registry, "utf8")) + "// Demo tampered registry\n");
  await assert.rejects(runCli(root, ["verify"]), /source input mismatch/);
});

test('provider preparation replaces poisoned cache output with verified committed bytes', async t => {
  const {root,outDir} = await committedFixture(t);
  await writeFile(join(outDir,'site','marker.sh'), '#!/bin/sh\nexit 99\n');
  await writeFile(join(outDir,'site','workspace.html'), 'synthetic cache poison');
  await runCli(root,['prepare-deployment']);
  await assert.rejects(readFile(join(outDir,'site','marker.sh')), /ENOENT/);
  assert.deepEqual(await readFile(join(outDir,'site','workspace.html')), await readFile(join(root,'workspace.html')));
});

test('provider preparation refuses missing, empty, fork and changed artifacts', async t => {
  const {root,outDir,commit,built} = await committedFixture(t);
  await writeFile(join(outDir,'doctorcre-app.tar'), '');
  await assert.rejects(runCli(root,['prepare-deployment']), /digest mismatch/);
  await writeFile(join(outDir,'doctorcre-app.tar'), built.archive);
  await runCli(root,['prepare-deployment']);
  await buildArtifact({root,outDir,commit:'f'.repeat(40)});
  await assert.rejects(runCli(root,['prepare-deployment']), /source commit mismatch/);
  await buildArtifact({root,outDir,commit});
  await rm(join(outDir,'doctorcre-app.manifest.json'));
  await assert.rejects(runCli(root,['prepare-deployment']), /ENOENT/);
});
