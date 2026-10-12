import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { RUN_LIMITS } from '../../scripts/e2e-staging/run-limits.mjs';

const preload = new URL('../../scripts/e2e-staging/preload.mjs', import.meta.url).pathname;
const limitsModule = new URL('../../scripts/e2e-staging/run-limits.mjs', import.meta.url).href;

async function withPreload(t, body) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-preload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import promises from 'node:fs/promises';
    import { once } from 'node:events';
    import { join } from 'node:path';
    import { currentRun } from ${JSON.stringify(limitsModule)};
    const run = currentRun();
    run.reserveBytes(32);
    const before = run.snapshot().artifactBytes;
    ${body}
    run.dispose();
  `;
  const result = await promisify(execFile)(process.execPath, ['--import', preload, '--input-type=module', '-e', script], {
    timeout: 5_000,
    env: { ...process.env, E2E_RUN_SUPERVISED: '1', E2E_RUN_ID: 'synthetic-preload-run', E2E_V2_OUTPUT: root,
      E2E_RUN_LIMITS: JSON.stringify({ ...RUN_LIMITS, artifactBytes: 4_096 }), E2E_PROCESS_REGISTRY: join(root, 'groups.jsonl') },
  });
  assert.equal(result.stderr, '');
}

test('preload charges an explicitly accounted write once and still charges a direct SDK write', async t => {
  await withPreload(t, `
    const payload = Buffer.alloc(256, 7);
    const path = join(run.root, 'explicit.bin');
    await run.writeFile(path, payload, promises.writeFile);
    assert.equal(run.snapshot().artifactBytes - before, payload.length, 'explicit write charged once');
    assert.deepEqual(await promises.readFile(path), payload);
    await promises.writeFile(join(run.root, 'sdk.bin'), payload);
    assert.equal(run.snapshot().artifactBytes - before, payload.length * 2, 'SDK write remains accounted');
  `);
});

test('preload refuses an opaque SDK data source before it is consumed or written', async t => {
  await withPreload(t, `
    let consumed = 0;
    const opaque = { async *[Symbol.asyncIterator]() { consumed++; yield Buffer.alloc(4_096); } };
    const path = join(run.root, 'opaque.bin');
    await assert.rejects(promises.writeFile(path, opaque), error => error.code === 'artifact-size-unavailable');
    assert.equal(consumed, 0);
    assert.equal(fs.existsSync(path), false);
    assert.equal(run.snapshot().artifactBytes, before);
  `);
});

test('preload charges stream.end bytes including multibyte text', async t => {
  await withPreload(t, `
    const path = join(run.root, 'stream.txt');
    const payload = 'é'.repeat(129);
    const stream = fs.createWriteStream(path);
    const finished = once(stream, 'finish');
    stream.end(payload);
    await finished;
    assert.equal(run.snapshot().artifactBytes - before, Buffer.byteLength(payload));
    assert.equal(await promises.readFile(path, 'utf8'), payload);
  `);
});

test('preload refuses stream.end content exceeding the artifact quota', async t => {
  await withPreload(t, `
    const stream = fs.createWriteStream(join(run.root, 'oversize.bin'));
    const finished = once(stream, 'finish');
    stream.end(Buffer.alloc(run.limits.artifactBytes));
    await assert.rejects(finished, error => error.code === 'artifact-byte-limit');
    assert.equal(run.snapshot().stopReason, 'artifact-byte-limit');
    assert.equal(run.snapshot().artifactBytes, before);
    assert.equal(fs.statSync(join(run.root, 'oversize.bin')).size, 0);
  `);
});

test('Playwright attachment copy reserves quota before writing the destination', async t => {
  const helper = new URL('../../node_modules/playwright/lib/util.js', import.meta.url).href;
  await withPreload(t, `
    const source = join(run.root, 'controls.json');
    await promises.writeFile(source, Buffer.alloc(2000));
    const { normalizeAndSaveAttachment } = await import(${JSON.stringify(helper)});
    await assert.rejects(normalizeAndSaveAttachment(join(run.root, 'playwright'), 'staging-controls', { path: source }),
      error => error.code === 'artifact-byte-limit');
    const attachments = fs.existsSync(join(run.root, 'playwright', 'attachments'))
      ? fs.readdirSync(join(run.root, 'playwright', 'attachments')) : [];
    assert.deepEqual(attachments, []);
    assert.equal(run.snapshot().stopReason, 'artifact-byte-limit');
    const { directoryBytes } = await import(${JSON.stringify(limitsModule)});
    assert.ok(directoryBytes(run.root) <= run.limits.artifactBytes);
  `);
});

for (const method of ['copyFile', 'cp', 'copyFileSync', 'cpSync']) test(`preload ${method} refuses a copy before quota is exceeded`, async t => {
  await withPreload(t, `
    const source = join(run.root, 'source.bin'), destination = join(run.root, 'destination.bin');
    await promises.writeFile(source, Buffer.alloc(2000));
    const copy = () => ${method.endsWith('Sync') ? 'fs' : 'promises'}.${method}(source, destination);
    ${method.endsWith('Sync') ? 'assert.throws(copy,' : 'await assert.rejects(copy(),'} error => error.code === 'artifact-byte-limit');
    assert.equal(fs.existsSync(destination), false);
    assert.equal(run.snapshot().stopReason, 'artifact-byte-limit');
  `);
});

for (const method of ['copyFile', 'cp']) test(`preload callback ${method} refuses a copy before quota is exceeded`, async t => {
  await withPreload(t, `
    const source = join(run.root, 'source.bin'), destination = join(run.root, 'destination.bin');
    await promises.writeFile(source, Buffer.alloc(2000));
    await assert.rejects(new Promise((resolve, reject) => fs.${method}(source, destination, error => error ? reject(error) : resolve())),
      error => error.code === 'artifact-byte-limit');
    assert.equal(fs.existsSync(destination), false);
    assert.equal(run.snapshot().stopReason, 'artifact-byte-limit');
  `);
});

test('an explicitly reserved recursive evidence copy charges bytes once', async t => {
  await withPreload(t, `
    const source = join(run.root, 'private'), destination = join(run.root, 'public');
    await promises.mkdir(source);
    await promises.writeFile(join(source, 'image.png'), Buffer.alloc(256));
    const prior = run.snapshot().artifactBytes;
    await run.copyArtifacts(source, destination, (a, b) => promises.cp(a, b, { recursive: true }));
    assert.equal(run.snapshot().artifactBytes - prior, 256);
    assert.equal(fs.statSync(join(destination, 'image.png')).size, 256);
  `);
});
