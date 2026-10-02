import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from 'playwright';

import { buildArtifact, verifyArtifact } from "../scripts/artifact.mjs";

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
  assert.deepEqual(await readFile(join(first, "site", "progress-board.html")), await readFile(join(ROOT, "progress-board.html")));
  assert.deepEqual(await readFile(join(first, "site", "contracts", "lease-radar.v1.json")), await readFile(join(ROOT, "contracts", "lease-radar.v1.json")));
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
