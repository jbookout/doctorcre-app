#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { open, mkdir, readFile, writeFile, rename, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { boundary, recipes } from './recipes.mjs';

const defaultRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function argumentsFor(argv) {
  const command = argv.shift(), options = {}, operands = [];
  while (argv.length) {
    const word = argv.shift();
    if (['--run', '--root'].includes(word)) {
      assert.ok(argv[0] && !argv[0].startsWith('--'), `${word} requires a value`);
      assert.equal(options[word], undefined, `duplicate ${word}`); options[word] = argv.shift();
    } else { assert.ok(!word.startsWith('--'), `unknown option ${word}`); operands.push(word); }
  }
  assert.ok(['launch', 'doctor', 'drive', 'evidence', 'cleanup'].includes(command), 'command must be launch, doctor, drive, evidence, or cleanup');
  assert.ok(options['--run'] && isAbsolute(options['--run']), '--run must name an absolute disposable directory');
  assert.ok(command === 'launch' || !options['--root'], '--root belongs to launch');
  assert.equal(operands.length, command === 'drive' ? 1 : 0, 'unexpected or missing operand');
  if (command === 'drive') assert.ok(operands[0] === 'all' || Object.hasOwn(recipes, operands[0]), `unknown feature ${operands[0]}`);
  return { command, run: resolve(options['--run']), root: resolve(options['--root'] || defaultRoot), feature: operands[0] };
}

async function sourceSnapshot(root) {
  const paths = git(root, 'ls-files', '-z').split('\0').filter(path => /\.(?:m?js|html|css|json|geojson|svg)$/.test(path) && !path.startsWith('test-artifacts/') && !path.startsWith('.cursor/'));
  for (const path of ['contracts/app-routes.v1.json', 'js/slices.generated.js', 'tours/day-shell.generated.js']) {
    if (paths.includes(path)) continue;
    try { await readFile(join(root, path)); paths.push(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  paths.sort();
  const files = [];
  for (const path of paths) files.push({ path, sha256: hash(await readFile(join(root, path))) });
  return { source_commit: git(root, 'rev-parse', 'HEAD'), files, digest: hash(JSON.stringify(files)) };
}
async function verifySource(state) {
  const current = await sourceSnapshot(state.root);
  assert.equal(current.source_commit, state.source_commit, 'source revision changed since launch');
  assert.equal(current.digest, state.digest, 'source bytes changed since launch');
  assert.deepEqual(current.files, state.files, 'source file inventory changed since launch');
}

function processCommand(pid) {
  assert.ok(Number.isInteger(pid) && pid > 1, 'invalid owned PID');
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}
function owned(state) {
  assert.match(state.nonce, /^[a-f0-9-]{36}$/, 'invalid ownership nonce');
  const command = processCommand(state.pid);
  if (!command) return false;
  assert.ok(command.includes(join(state.root, 'scripts/serve.mjs')) && command.split(/\s+/).includes(`--verify-doctorcre-owner=${state.nonce}`), 'PID ownership mismatch; refusing to touch another process');
  return true;
}
async function stop(state) {
  if (!owned(state)) return { stopped: false, already_exited: true };
  process.kill(state.pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) { if (!processCommand(state.pid)) return { stopped: true }; await delay(50); }
  if (owned(state)) process.kill(state.pid, 'SIGKILL');
  for (let i = 0; i < 100; i++) { if (!processCommand(state.pid)) return { stopped: true }; await delay(50); }
  throw Error('owned server did not stop');
}

async function filesIn(dir, prefix = '') {
  const rows = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    assert.ok(!entry.isSymbolicLink(), `evidence symlink refused: ${path}`);
    if (entry.isDirectory()) rows.push(...await filesIn(dir, path));
    else if (entry.isFile() && path !== 'manifest.json') {
      const bytes = await readFile(join(dir, path)); rows.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
async function manifest(run, previous) {
  const files = await filesIn(join(run, 'evidence'));
  if (previous) {
    assert.equal(previous.schema, 'doctorcre-verification-evidence.v1');
    const current = new Map(files.map(row => [row.path, row]));
    for (const row of previous.files) {
      assert.deepEqual(current.get(row.path), row, `previously sealed evidence changed or removed: ${row.path}`);
    }
  }
  await save(join(run, 'evidence/manifest.json'), { schema: 'doctorcre-verification-evidence.v1', files });
  return files;
}
async function verifiedManifest(run) {
  const record = await json(join(run, 'evidence/manifest.json'));
  assert.equal(record.schema, 'doctorcre-verification-evidence.v1');
  assert.ok(record.files.length > 0, 'no evidence retained');
  assert.deepEqual(await filesIn(join(run, 'evidence')), record.files, 'evidence bytes or file inventory changed');
  return record;
}
async function evidence(run) {
  const record = await verifiedManifest(run);
  return { evidence: join(run, 'evidence'), files: record.files.length };
}

async function launch({ run, root }) {
  root = await realpath(root);
  assert.notEqual(run, root, '--run cannot be the source checkout itself');
  const seed = await json(join(root, 'data/board-seed.json'));
  assert.equal(seed.fixture?.synthetic, true, 'launch requires the repository synthetic fixture seed');
  assert.equal(seed.fixture?.schema, 'doctorcre-demo-board.v1');
  // Exclusive creation refuses a second owner or accidental reuse of prior proof.
  await mkdir(dirname(run), { recursive: true });
  await mkdir(run, { recursive: false });
  await mkdir(join(run, 'scratch')); await mkdir(join(run, 'evidence'));
  const snapshot = await sourceSnapshot(root), nonce = randomUUID();
  const log = await open(join(run, 'scratch/server.log'), 'wx');
  const child = spawn(process.execPath, [join(root, 'scripts/serve.mjs'), `--verify-doctorcre-owner=${nonce}`], {
    cwd: root, detached: true, env: { PATH: process.env.PATH, PORT: '0', NODE_ENV: 'test' }, stdio: ['ignore', log.fd, log.fd],
  });
  const state = { schema: 'doctorcre-verification-run.v1', root, pid: child.pid, nonce, ...snapshot, origin: null };
  await save(join(run, 'scratch/state.json'), state); child.unref(); await log.close();
  try {
    let spawnError; child.on('error', error => { spawnError = error; });
    for (let i = 0; i < 200; i++) {
      if (spawnError) throw spawnError;
      const logText = await readFile(join(run, 'scratch/server.log'), 'utf8');
      const origin = logText.match(/DoctorCRE fixture server: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (origin) { state.origin = origin; break; }
      assert.ok(processCommand(state.pid), 'fixture server exited before readiness'); await delay(50);
    }
    assert.ok(state.origin, 'fixture server readiness timed out');
    await save(join(run, 'scratch/state.json'), state);
    await doctor(run);
    await save(join(run, 'evidence/launch.json'), { command: 'launch', root, origin: state.origin, pid: state.pid, source_commit: state.source_commit, source_digest: state.digest, synthetic: true });
    await manifest(run, null);
    return { origin: state.origin, pid: state.pid, source_commit: state.source_commit, evidence: join(run, 'evidence') };
  } catch (error) {
    await stop(state); await rename(join(run, 'scratch'), join(run, 'retired-launch-scratch'));
    throw error;
  }
}

async function doctor(run) {
  const state = await json(join(run, 'scratch/state.json'));
  assert.equal(state.schema, 'doctorcre-verification-run.v1');
  assert.ok(owned(state), 'owned server is no longer running');
  assert.match(state.origin, /^http:\/\/127\.0\.0\.1:\d+$/, 'non-loopback instance refused');
  const port = new URL(state.origin).port;
  let sockets;
  try { sockets = execFileSync('lsof', ['-nP', '-a', '-p', String(state.pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' }); }
  catch { throw Error('owned server PID does not own the stated loopback port (read-only lsof check failed)'); }
  assert.ok(sockets.split('\n').includes(`n127.0.0.1:${port}`), 'owned server PID does not own the stated loopback port');
  await verifySource(state);
  const releaseResponse = await fetch(state.origin + '/app-release', { signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert.equal(releaseResponse.status, 200, 'fixture identity did not answer');
  const release = await releaseResponse.json();
  assert.equal(release.service, 'doctorcre-app'); assert.equal(release.environment, 'fixture');
  const sample = state.files.find(row => row.path === 'js/boot-mode.js');
  assert.ok(sample, 'expected app boot module absent');
  const served = await fetch(state.origin + '/' + sample.path, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert.equal(served.status, 200); assert.equal(hash(Buffer.from(await served.arrayBuffer())), sample.sha256, 'served build does not match captured source');
  return { origin: state.origin, source_commit: state.source_commit, source_digest: state.digest, process_owned: true, fixture: true };
}

async function drive({ run, feature }) {
  await doctor(run);
  await evidence(run);
  const state = await json(join(run, 'scratch/state.json'));
  const names = feature === 'all' ? Object.keys(recipes) : [feature];
  for (const name of names) await driveFeature(run, state, name);
  await verifySource(state);
  return { features: names, ...(await evidence(run)) };
}
async function driveFeature(run, state, feature) {
  // Keep the accepted inventory across asynchronous recipes; rereading it at
  // the end would let a replacement manifest authorize changed earlier proof.
  const previous = await verifiedManifest(run);
  const dir = join(run, 'evidence', `${feature}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir);
  const helperFiles = ['verify-doctorcre.mjs', 'recipes.mjs'];
  const helper_digests = {};
  for (const name of helperFiles) helper_digests[name] = hash(await readFile(new URL(name, import.meta.url)));
  const record = { feature, source_commit: state.source_commit, source_digest: state.digest, helper_digests, entry_points: [], actions: [], assertions: [], browser_errors: [], interception_errors: [], requests: [], blocked_external_requests: [], status: 'running' };
  let browser, context, page, failure;
  const fail = error => { failure ||= error; record.status = 'failed'; record.error = failure.message; };
  let rejectInterception;
  const interceptionFailed = new Promise((_, reject) => { rejectInterception = reject; });
  // Route callbacks run outside the awaited recipe. Consume their rejection
  // immediately, then race it with the recipe to enter the retained failure path.
  interceptionFailed.catch(() => {});
  const notePage = observed => observed.on('pageerror', error => record.browser_errors.push(error.message));
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    context.setDefaultTimeout(30_000); context.on('page', notePage);
    await context.route('**/*', async route => {
      try {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== state.origin) {
          record.blocked_external_requests.push({ origin: url.origin, method: request.method(), resource: request.resourceType() });
          return await route.abort();
        }
        record.requests.push({ path: url.pathname + url.search, method: request.method(), resource: request.resourceType(), boundary: ['/mcp', '/api/'].some(prefix => url.pathname.startsWith(prefix)) });
        if (url.searchParams.get('mode') === 'live') return await route.abort('blockedbyclient');
        if (await boundary(route, feature)) return;
        return await route.continue();
      } catch (error) {
        record.interception_errors.push({ url: route.request().url(), error: error.message });
        const diagnostic = Error(`network interception failed: ${error.message}`);
        fail(diagnostic); rejectInterception(diagnostic);
        await route.abort('failed').catch(() => {});
      }
    });
    await context.addInitScript(() => {
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Verification cannot capture host devices', 'NotAllowedError'); };
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    const capture = async (label, target = page) => {
      await target.screenshot({ path: join(dir, `${label}.png`), fullPage: true, animations: 'disabled' });
      await writeFile(join(dir, `${label}.aria.txt`), await target.locator('body').ariaSnapshot());
      record.actions.push({ kind: 'capture', label, url: target.url() });
    };
    const action = async (label, operation) => {
      record.actions.push({ kind: 'action', label, at: new Date().toISOString() });
      await operation();
    };
    const check = async (label, operation) => {
      try { await operation(); record.assertions.push({ label, passed: true }); }
      catch (error) { record.assertions.push({ label, passed: false, error: error.message }); throw error; }
    };
    const entry = (id, route) => record.entry_points.push({ id, route });
    await Promise.race([recipes[feature]({ page, context, origin: state.origin, action, capture, check, entry }), interceptionFailed]);
    await check('No network interception errors', async () => assert.deepEqual(record.interception_errors, []));
    await check('No unhandled browser errors', async () => assert.deepEqual(record.browser_errors, []));
    record.status = 'passed';
  } catch (error) {
    fail(error);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(dir, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
      await writeFile(join(dir, 'failure.aria.txt'), await page.locator('body').ariaSnapshot()).catch(() => {});
    }
  } finally {
    if (context) await context.tracing.stop({ path: join(dir, 'trace.zip') }).catch(error => {
      record.trace_error = error.message; fail(error);
    });
    if (browser) await browser.close().catch(fail);
    if (!failure) await verifySource(state).catch(fail);
    await save(join(dir, 'result.json'), record);
    await manifest(run, previous).catch(async error => {
      fail(error);
      record.manifest_error = error.message;
      await save(join(dir, 'result.json'), record);
    });
  }
  if (failure) throw Error(`${feature}: ${failure.message}; evidence retained at ${dir}; run doctor and cleanup before retry`);
}

async function cleanup(run) {
  const statePath = join(run, 'scratch/state.json');
  let state;
  try { state = await json(statePath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { already_clean: true, ...(await evidence(run)) }; }
  const result = await stop(state);
  await mkdir(join(run, '_to_delete'), { recursive: true });
  await rename(join(run, 'scratch'), join(run, '_to_delete', `scratch-${state.nonce}`));
  const previous = await verifiedManifest(run);
  await save(join(run, 'evidence/cleanup.json'), { ...result, pid: state.pid, source_commit: state.source_commit, scratch_retired: true, evidence_preserved: true });
  await manifest(run, previous);
  return { ...result, scratch_retired: true, ...(await evidence(run)) };
}

let parsed;
try {
  parsed = argumentsFor(process.argv.slice(2));
  const { command, run } = parsed;
  const result = command === 'launch' ? await launch(parsed) : command === 'doctor' ? await doctor(run)
    : command === 'drive' ? await drive(parsed) : command === 'evidence' ? await evidence(run) : await cleanup(run);
  console.log(JSON.stringify({ command, ok: true, ...result }));
} catch (error) {
  console.error(JSON.stringify({ command: parsed?.command || process.argv[2], ok: false, error: error.message }));
  process.exitCode = 1;
}
