import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, appendFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, '.cursor/skills/verify-doctorcre/verify-doctorcre.mjs');
async function callWith(helper, run, ...args) {
  try {
    const result = await exec(process.execPath, [helper, ...args, '--run', run], { cwd: root, timeout: 90_000 });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout || '', stderr: error.stderr || '', code: error.code };
  }
}
const call = (run, ...args) => callWith(cli, run, ...args);
async function files(dir) {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }))).flat();
}
function passed(result) {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
}

// Disposable helper copies exercise faults through the existing CLI and HTTP
// seams without adding fault switches to the verification tool.
async function faultHelper(transform) {
  const scratch = await mkdtemp(join(tmpdir(), 'doctorcre-verify-fault-'));
  const directory = join(scratch, '.cursor/skills/verify-doctorcre');
  await mkdir(directory, { recursive: true });
  await symlink(join(root, 'test'), join(scratch, 'test'), 'dir');
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  await writeFile(join(directory, 'verify-doctorcre.mjs'), await readFile(cli));
  const recipe = await readFile(join(root, '.cursor/skills/verify-doctorcre/recipes.mjs'), 'utf8');
  await writeFile(join(directory, 'recipes.mjs'), transform(recipe));
  return join(directory, 'verify-doctorcre.mjs');
}
async function verdict(run, feature) {
  const directories = (await readdir(join(run, 'evidence'))).filter(name => name.startsWith(feature + '-')).sort();
  const directory = join(run, 'evidence', directories.at(-1));
  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  assert.equal(result.status, 'failed');
  assert.ok((await readFile(join(directory, 'trace.zip'))).length > 0, 'failed drive retains its trace');
  return result;
}

test('later drives cannot reseal changed or removed earlier evidence', { timeout: 180_000 }, async t => {
  for (const operation of ['appendFile', 'unlink']) {
    await t.test(operation, async () => {
      const run = join(await mkdtemp(join(tmpdir(), 'doctorcre-verify-sealed-')), 'run');
      t.after(() => call(run, 'cleanup'));
      passed(await call(run, 'launch'));
      passed(await call(run, 'drive', 'home'));
      const proof = (await files(join(run, 'evidence'))).find(path => path.endsWith('/before.png'));
      const sealed = await readFile(join(run, 'evidence/manifest.json'));
      const helper = await faultHelper(source => source + `
        const home = recipes.home;
        recipes.home = async h => {
          await home({ ...h, capture: async (...args) => {
            await h.capture(...args);
            if (args[0] === 'entry-bookmark') {
              const fs = await import('node:fs/promises');
              await fs.${operation}(${JSON.stringify(proof)}${operation === 'appendFile' ? ", 'tampered-proof'" : ''});
            }
          } });
        };
      `);
      const result = await callWith(helper, run, 'drive', 'home');
      assert.notEqual(result.code, 0, 'later drive rejects previously sealed artifact changes');
      assert.match(result.stderr, /sealed evidence|evidence bytes/);
      assert.deepEqual(await readFile(join(run, 'evidence/manifest.json')), sealed, 'failed extension preserves earlier digests');
      assert.notEqual((await call(run, 'evidence')).code, 0);
      assert.notEqual((await call(run, 'cleanup')).code, 0, 'cleanup cannot certify changed proof');
    });
  }
});

test('source revision and source bytes drift during a recipe retain a failed verdict', { timeout: 180_000 }, async t => {
  for (const drift of ['revision', 'bytes']) {
    await t.test(drift, async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'doctorcre-verify-source-'));
      const checkout = join(scratch, 'source'), run = join(scratch, 'run');
      await exec('git', ['clone', '--quiet', '--shared', root, checkout]);
      for (const path of ['contracts/app-routes.v1.json', 'js/slices.generated.js', 'tours/day-shell.generated.js']) {
        await writeFile(join(checkout, path), await readFile(join(root, path)));
      }
      t.after(() => call(run, 'cleanup'));
      passed(await call(run, 'launch', '--root', checkout));
      const helper = await faultHelper(source => source + `
        const home = recipes.home;
        recipes.home = async h => {
          await home(h);
          ${drift === 'revision'
            ? `const { execFileSync } = await import('node:child_process'); execFileSync('git', ['update-ref', 'HEAD', 'HEAD^'], { cwd: ${JSON.stringify(checkout)} });`
            : `const { appendFile } = await import('node:fs/promises'); await appendFile(${JSON.stringify(join(checkout, 'js/boot-mode.js'))}, '\\n// source drift\\n');`}
        };
      `);
      const result = await callWith(helper, run, 'drive', 'home');
      assert.notEqual(result.code, 0, 'source drift cannot publish success');
      assert.match((await verdict(run, 'home')).error, /source (revision|bytes) changed/);
      passed(await call(run, 'cleanup'));
      passed(await call(run, 'evidence'));
    });
  }
});

test('a later drive keeps its accepted inventory when the on-disk manifest is replaced', { timeout: 90_000 }, async t => {
  const run = join(await mkdtemp(join(tmpdir(), 'doctorcre-verify-replaced-manifest-')), 'run');
  t.after(() => call(run, 'cleanup'));
  passed(await call(run, 'launch'));
  passed(await call(run, 'drive', 'home'));
  const proof = (await files(join(run, 'evidence'))).find(path => path.endsWith('/before.png'));
  const manifestPath = join(run, 'evidence/manifest.json');
  const helper = await faultHelper(source => source + `
    const home = recipes.home;
    recipes.home = async h => {
      await home(h);
      const { appendFile, readFile, writeFile } = await import('node:fs/promises');
      const { createHash } = await import('node:crypto');
      await appendFile(${JSON.stringify(proof)}, 'tampered-proof');
      const bytes = await readFile(${JSON.stringify(proof)});
      const manifest = JSON.parse(await readFile(${JSON.stringify(manifestPath)}, 'utf8'));
      const row = manifest.files.find(row => ${JSON.stringify(proof)}.endsWith(row.path));
      row.bytes = bytes.length; row.sha256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(${JSON.stringify(manifestPath)}, JSON.stringify(manifest));
    };
  `);
  const result = await callWith(helper, run, 'drive', 'home');
  assert.notEqual(result.code, 0, 'a replacement manifest cannot reauthorize changed earlier proof');
  assert.match((await verdict(run, 'home')).manifest_error, /sealed evidence/);
});

test('malformed MCP input and throwing interception handlers retain failed drive diagnostics', { timeout: 180_000 }, async t => {
  for (const fault of ['missing-params', 'invalid-json', 'throwing-handler']) {
    await t.test(fault, async () => {
      const run = join(await mkdtemp(join(tmpdir(), 'doctorcre-verify-intercept-')), 'run');
      t.after(() => call(run, 'cleanup'));
      passed(await call(run, 'launch'));
      const helper = await faultHelper(source =>
        (fault === 'throwing-handler'
          ? source.replace("if (url.pathname === '/mcp') {", "if (url.pathname === '/mcp') { throw Error('synthetic fixture handler failed');")
          : source) + `
          const home = recipes.home;
          recipes.home = async h => {
            await h.page.goto(h.origin);
            await h.page.evaluate(body => fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {}), ${JSON.stringify(fault === 'invalid-json' ? '{' : fault === 'throwing-handler' ? '{"params":{"name":"list-doc-suggestions","arguments":{}}}' : '{}')});
            await home(h);
          };
        `);
      const result = await callWith(helper, run, 'drive', 'home');
      assert.notEqual(result.code, 0);
      const record = await verdict(run, 'home');
      assert.match(record.error, /interception|MCP/);
      assert.ok(record.interception_errors.length > 0, 'interception diagnostics belong to the failed iteration');
      passed(await call(run, 'cleanup'));
      passed(await call(run, 'evidence'));
    });
  }
});

test('vendor recipe rejects wrong displayed membership and ownership after filter and reset', { timeout: 180_000 }, async t => {
  for (const stage of ['filter', 'filter-owners', 'reset', 'reset-owners']) {
    await t.test(stage, async () => {
      const run = join(await mkdtemp(join(tmpdir(), 'doctorcre-verify-owner-')), 'run');
      t.after(() => call(run, 'cleanup'));
      passed(await call(run, 'launch'));
      const helper = await faultHelper(source => source.replace('directoryFixture(url.href)', `(() => {
        const expected = directoryFixture(url.href);
        if (${stage.startsWith('filter') ? "url.searchParams.get('owner') === 'dell'" : "url.searchParams.get('owner') !== 'dell'"}) {
          ${stage.endsWith('owners')
            ? "expected.rows = expected.rows.map(row => ({ ...row, owner_label: row.owner_label === 'Dell' ? 'Joe' : 'Dell', owned_by_viewer: !row.owned_by_viewer }));"
            : "const wrong = new URL(url); wrong.searchParams.set('owner', 'joe'); expected.rows = directoryFixture(wrong.href).rows;"}
        }
        return expected;
      })()`));
      const result = await callWith(helper, run, 'drive', 'vendors');
      assert.notEqual(result.code, 0, `recipe rejects wrong rows at ${stage}`);
      const record = await verdict(run, 'vendors');
      assert.ok(record.assertions.some(row => !row.passed && /membership|owners/.test(row.label)));
      passed(await call(run, 'cleanup'));
      passed(await call(run, 'evidence'));
    });
  }
});

test('verification CLI owns independent instances and retains checked proof after cleanup', { timeout: 180_000 }, async t => {
  const first = join(await mkdtemp(join(tmpdir(), 'doctorcre-verify-first-')), 'run');
  const second = join(await mkdtemp(join(tmpdir(), 'doctorcre-verify-second-')), 'run');
  t.after(async () => { await call(first, 'cleanup'); await call(second, 'cleanup'); });
  passed(await call(first, 'launch'));
  passed(await call(second, 'launch'));
  passed(await call(first, 'doctor'));
  passed(await call(second, 'doctor'));
  const statePath = join(first, 'scratch/state.json');
  const original = await readFile(statePath, 'utf8');
  const state = JSON.parse(original);
  const other = JSON.parse(await readFile(join(second, 'scratch/state.json'), 'utf8'));
  await writeFile(statePath, JSON.stringify({ ...state, origin: other.origin }));
  assert.notEqual((await call(first, 'doctor')).code, 0, 'the server PID must own the stated port');
  await writeFile(statePath, JSON.stringify({ ...state, nonce: '00000000-0000-4000-8000-000000000000' }));
  assert.notEqual((await call(first, 'doctor')).code, 0, 'a PID without the ownership nonce cannot be driven');
  await writeFile(statePath, original);
  assert.notEqual((await call(first, 'launch')).code, 0, 'a second launch cannot replace an owned instance');
  assert.notEqual((await call(first, 'drive', 'unknown-feature')).code, 0, 'unknown features cannot pass');
  passed(await call(first, 'drive', 'all'));
  passed(await call(first, 'evidence'));
  const proof = (await files(join(first, 'evidence'))).filter(path => /\.(png|zip|txt|json)$/.test(path) && !path.endsWith('/manifest.json'));
  assert.ok(proof.some(path => path.endsWith('.png')), 'proof includes visible app state');
  assert.ok(proof.some(path => path.endsWith('.zip')), 'proof includes the action trace');
  const bytes = new Map(await Promise.all(proof.map(async path => [path, await readFile(path)])));
  passed(await call(first, 'cleanup'));
  assert.notEqual((await call(first, 'doctor')).code, 0, 'a cleaned instance is not driveable');
  passed(await call(second, 'doctor'));
  passed(await call(first, 'evidence'));
  for (const [path, expected] of bytes) assert.deepEqual(await readFile(path), expected, `cleanup preserves ${path}`);
  await appendFile(proof.find(path => path.endsWith('.png')), 'tampered-proof');
  assert.notEqual((await call(first, 'evidence')).code, 0, 'evidence must read artifact bytes and reject a changed digest');
});

test('feature map keeps poteto sections, schema shape, and executable recipes aligned', async () => {
  const directory = join(root, '.cursor/skills/verify-doctorcre/features');
  const parse = text => JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
  const index = parse(await readFile(join(directory, 'README.md'), 'utf8'));
  assert.equal(index.schema, 'verify-feature-map.v1');
  assert.equal(index.product, 'doctorcre');
  const { recipes } = await import('../.cursor/skills/verify-doctorcre/recipes.mjs');
  assert.deepEqual(index.features.map(row => row.id).sort(), Object.keys(recipes).sort());
  assert.deepEqual((await readdir(directory)).filter(path => path !== 'README.md').sort(), index.features.map(row => row.file.slice(9)).sort());
  for (const row of index.features) {
    const source = await readFile(join(directory, row.file.slice(9)), 'utf8');
    assert.deepEqual([...source.matchAll(/^## (.+)$/gm)].map(match => match[1]), [
      'Sub-features', 'How to get to it (user POV)', 'Driving it with verify-doctorcre', 'Gotchas',
    ]);
    assert.match(source, /Preconditions:/);
    const feature = parse(source);
    assert.deepEqual(Object.keys(feature).sort(), ['id', 'title', 'entryPoints', 'subFeatures', 'userRoute', 'observableEndState', 'storedValues', 'gotchas'].sort());
    assert.equal(feature.id, row.id);
    assert.ok(feature.entryPoints.length);
    assert.equal(new Set(feature.entryPoints.map(entry => entry.id)).size, feature.entryPoints.length);
    for (const entry of feature.entryPoints) {
      assert.deepEqual(Object.keys(entry).sort(), ['handles', 'id', 'route']);
      assert.ok(entry.route.startsWith('/') && !entry.route.includes('mode=live'));
      assert.ok(entry.handles.length);
    }
  }
});
