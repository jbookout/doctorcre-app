import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WAIT_MS } from "./browser-harness.mjs";
import { journeyFiles } from "../scripts/browser-proof-contract.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const list = async (path) => (await readdir(new URL(path, root))).filter((name) => name.endsWith(".e2e.ts")).sort();

// The merged V1 journeys the deterministic e2e suite must cover, one file each.
const JOURNEYS = journeyFiles.map(file => file.split("/").at(-1).replace(/\.e2e\.ts$/, ""));

test("the declared Node minimum supports the runner and is exercised in CI", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  const runner = JSON.parse(await read("node_modules/e2e/package.json"));
  assert.equal(pkg.engines.node, runner.engines.node, "the app must declare the runner's Node floor");
  assert.equal(lock.packages[""].engines.node, pkg.engines.node, "the lockfile must declare the same floor");
  const minimum = pkg.engines.node.match(/^>=(\d+\.\d+\.\d+)$/)?.[1];
  assert.ok(minimum, "declare an exact minimum Node version");
  const workflow = await read(".github/workflows/e2e.yml");
  assert.equal(workflow.match(/^\s+node-version: (\S+)$/m)?.[1], minimum, "journeys must run on the declared minimum");
  assert.match(await read("README.md"), new RegExp(`Node\\.js ${minimum.replaceAll(".", "\\.")} or newer`));
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("node_modules/e2e/dist/cli/bin.js", root)), "run", "--help"], {
    cwd: fileURLToPath(root), env: { ...process.env, E2E_TELEMETRY_DISABLED: "1" }, encoding: "utf8", timeout: WAIT_MS,
  });
  assert.match(output, /Usage: e2e run/, "the runner must reach test discovery options on this runtime");
});

test("e2e is pinned exactly and starts the fixture app itself", async () => {
  const pkg = JSON.parse(await read("package.json"));
  for (const name of ["e2e", "@e2e-dev/web"]) assert.match(pkg.devDependencies[name] ?? "", /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly`);
  const config = await read("e2e.config.ts");
  assert.match(config, /executable: 'npm', args: \['run', 'serve'\]/, "the runner starts the fixture server");
  assert.match(config, /PORT: '\{port\}'/, "the runner picks a free port");
  assert.match(config, /E2E_TELEMETRY_DISABLED/, "the config turns telemetry off");
});

test("the deterministic suite covers every merged V1 journey without a model", async () => {
  assert.deepEqual(await list("tests/journeys/"), JOURNEYS.map((name) => `${name}.e2e.ts`));
  for (const name of JOURNEYS) {
    const source = await read(`tests/journeys/${name}.e2e.ts`);
    assert.doesNotMatch(source, /\bagent\b/, `${name} must not call a model`);
  }
  assert.equal((await list("tests/agent/")).length, 3, "three journeys keep a local agent variant");
});

test("CI runs only the deterministic suite, with no model and no telemetry", async () => {
  const workflow = await read(".github/workflows/e2e.yml");
  assert.match(workflow, /^\s+- run: node scripts\/browser-product-proof\.mjs/m);
  const producer=await read('scripts/browser-product-proof.mjs');
  assert.match(producer, /'run','tests\/journeys','--reporter'/);
  assert.match(producer, /--test','test\/browser-product-proof\.test\.mjs/);
  assert.match(workflow, /E2E_TELEMETRY_DISABLED: "1"/);
  assert.match(workflow, /- run: npm run privacy:check\n        env:\n          DOCTORCRE_PRIVACY_CORPUS_JSON: \$\{\{ secrets\.DOCTORCRE_PRIVACY_CORPUS_JSON \}\}/);
  const withoutPrivacySecret = workflow.replace('${{ secrets.DOCTORCRE_PRIVACY_CORPUS_JSON }}', '');
  assert.doesNotMatch(withoutPrivacySecret, /tests\/agent|secrets\.|API_KEY|e2e login/);
  assert.doesNotMatch(await read(".github/workflows/ci.yml"), /e2e run/, "e2e stays out of the required test job");
});

// A file-level pass cannot hide a skipped shell entry or invoice write path.
test('the product-owned required manifest enumerates every deterministic entry',async()=>{
  const declared=JSON.parse(await read('tests/journeys/required-coverage.json')).tests;
  const actual=[];
  for(const name of JOURNEYS) {
    const source=await read(`tests/journeys/${name}.e2e.ts`);
    for(const match of source.matchAll(/test\('([^']+)'/g)) actual.push({file:`tests/journeys/${name}.e2e.ts`,title:match[1]});
  }
  assert.deepEqual(declared,actual);
});

test('proof checks native and continuity origins without a special asset route', async () => {
  const hook = await read('tests/journeys/test.mjs');
  assert.match(hook, /test.beforeEach/);
  assert.match(hook, /assertServedBuild/);
  assert.match(hook, /app.baseUrl/);
  for (const name of JOURNEYS) assert.match(await read(`tests/journeys/${name}.e2e.ts`), /from ['"]\.\/test\.mjs['"]/);
  assert.match(await read('test/browser-product-proof.test.mjs'), /assertServedBuild\(server.origin/);
  assert.doesNotMatch(await read('scripts/serve.mjs'), /proofAsset|__proof-assets/);
  assert.doesNotMatch(await read('scripts/browser-product-proof.mjs'), /fixtureServer|__proof-assets/);
});

test('proof failures print the underlying reason', async t => {
  // Run a source-only copy with a fake Git executable: deterministic even on
  // committed CI source, with no browser/build subprocess to intercept.
  const { mkdtemp, writeFile, mkdir, cp, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'proof-error-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL('scripts', root)), join(dir, 'scripts'), { recursive: true });
  await cp(fileURLToPath(new URL('package.json', root)), join(dir, 'package.json'));
  for (const name of ['node_modules', 'js', 'contracts', 'test', 'tests'])
    await symlink(fileURLToPath(new URL(name, root)), join(dir, name));
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'bin/git'), '#!/bin/sh\necho " M tracked-source"\n', { mode: 0o755 });
  let result;
  try {
    execFileSync(process.execPath, ['scripts/browser-product-proof.mjs'], {
      cwd: dir, encoding: 'utf8', timeout: WAIT_MS,
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` }, stdio: 'pipe',
    });
  } catch (error) { result = error; }
  assert.ok(result);
  assert.match(result.stderr, /Browser product proof refused in source: product proof requires committed source/);
});

test('proof and continuity consume the product-owned coverage definitions', async () => {
  const producer = await read('scripts/browser-product-proof.mjs');
  const continuity = await read('test/browser-product-proof.test.mjs');
  assert.match(producer, /import .*journeyFiles.*continuityCases.*browser-proof-contract/);
  assert.match(continuity, /import .*continuityCases.*browser-proof-contract/);
  assert.doesNotMatch(producer, /const journeys=\[/);
  assert.doesNotMatch(continuity, /for \(const width of \[/);
});

test('W6 uses the suite failure-only recording policy', async () => {
  assert.doesNotMatch(await read('tests/journeys/w06-tours-drafts.e2e.ts'), /video: 'on'|trace: 'on'/);
});

test('served-build oracle rejects wrong roots and identity with a clean control', async t => {
  const { assertServedBuild } = await import('../scripts/browser-proof-contract.mjs');
  const { createHash } = await import('node:crypto');
  const { createServer } = await import('node:http');
  const manifest = JSON.stringify({ source_commit: 'a'.repeat(40), files: [] });
  const expected = { sourceCommit: 'a'.repeat(40), manifestDigest: createHash('sha256').update(manifest).digest('hex') };
  let body = manifest, status = 200;
  const server = createServer((request, response) => {
    assert.equal(request.url, '/artifact-manifest.json');
    response.writeHead(status); response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await assertServedBuild(origin, expected);
  status = 404;
  await assert.rejects(assertServedBuild(origin, expected), /served build manifest unavailable/);
  status = 200; body = JSON.stringify({ source_commit: 'b'.repeat(40), files: [] });
  await assert.rejects(assertServedBuild(origin, expected), /served build source commit mismatch/);
  body = JSON.stringify({ source_commit: 'a'.repeat(40), files: ['different build'] });
  await assert.rejects(assertServedBuild(origin, expected), /served build manifest digest mismatch/);
  body = manifest;
  await assertServedBuild(origin, expected);
});

test('every native entry refuses the working-tree server when a build is bound', async () => {
  let result;
  try {
    execFileSync(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'run', 'tests/journeys', '--reporter', 'list'], {
      cwd: fileURLToPath(root), encoding: 'utf8', timeout: WAIT_MS * 4,
      env: { ...process.env, CI: '1', E2E_TELEMETRY_DISABLED: '1', BROWSER_PROOF_ROOT: '',
        BROWSER_PROOF_BINDING: JSON.stringify({ sourceCommit: 'a'.repeat(40), manifestDigest: 'b'.repeat(64) }) }, stdio: 'pipe',
    });
  } catch (error) { result = error; }
  assert.ok(result, 'the native runner must reject omitted build-root wiring');
  assert.match(result.stdout + result.stderr, /served build manifest unavailable/);
  const report = JSON.parse(await read('.e2e/report.json'));
  const declared = JSON.parse(await read('tests/journeys/required-coverage.json')).tests;
  for (const { file, title } of declared) {
    const entry = report.run.results.find(row => row.testId === `${file}::${encodeURIComponent(title)}` && row.selected);
    assert.equal(entry?.status, 'failed', `${file}: ${title} must reject the unbound server`);
    assert.match(JSON.stringify(entry.attempts), /served build manifest unavailable/);
  }
});
