import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSlices } from '../js/slice-registration.js';

export const GENERATED_PATHS = ['contracts/app-routes.v1.json', 'js/slices.generated.js'];
const SHARED = new Set([...GENERATED_PATHS, 'contracts/routes.v1.json', 'js/app-shell.js',
  'js/slice-registration.js', 'js/app-layout.js', 'css/app-shell.css', 'scripts/slices.mjs', 'scripts/check-repository.mjs',
  'scripts/artifact.mjs', 'package.json', 'test/w1-shell-browser.test.mjs',
  'test/progress-directory-browser.test.mjs', 'test/control-room.test.mjs', 'test/app-navigation.test.mjs', 'test/ia-routes.test.mjs']);
const safePath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..') && posix.normalize(path) === path;

export function assertSliceOwnership(slices) {
  const owners = new Map();
  for (const slice of slices) {
    assert.match(slice.id, /^[a-z][a-z0-9-]*$/, 'slice id must be a descriptive slug');
    for (const path of [`js/slices/${slice.id}.js`, `contracts/routes/${slice.id}.json`, ...(slice.files || [])]) {
      assert.ok(safePath(path), `unsafe slice file: ${path}`);
      if (owners.has(path)) throw new Error(`${path} is written by ${owners.get(path)} and ${slice.id}`);
      if (SHARED.has(path)) throw new Error(`shared integration file cannot be slice-owned: ${path}`);
      owners.set(path, slice.id);
    }
  }
  return owners;
}

export function assembleSlices(slices, fragments, metadata) {
  assertSliceOwnership(slices);
  assert.equal(metadata.schema, 'doctorcre-app-routes.v1');
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
  const seen = new Set();
  const assemble = (key, target) => Object.fromEntries(fragments.flatMap(f => f[key] || [])
    .sort((a, b) => a.order - b.order || a.path.localeCompare(b.path)).map(row => {
      assert.ok(typeof row.path === 'string' && row.path.startsWith('/') && !row.path.includes('?'), 'route must be an absolute pathname');
      assert.ok(Number.isFinite(row.order), `route needs an order: ${row.path}`);
      if (seen.has(row.path)) throw new Error(`duplicate route: ${row.path}`);
      seen.add(row.path);
      assert.ok(typeof row[target] === 'string' && (target === 'asset' ? safePath(row[target]) : row[target].startsWith('/')), `invalid route target: ${row.path}`);
      return [row.path, row[target]];
    }));
  const contract = { ...metadata, routes: assemble('routes', 'asset'), redirects: assemble('redirects', 'to') };
  const { navigationItems, sectionForRoute } = registerSlices(slices);
  const nav = new Set();
  for (const slice of slices) for (const item of slice.navigation || []) assert.ok(Number.isFinite(item.order), `navigation needs an order: ${slice.id}`);
  for (const item of navigationItems) {
    assert.ok(item.label && item.href && ['Workspace', 'Updates', 'Operations', 'Reference', undefined].includes(item.group), 'invalid navigation entry');
    assert.ok(Object.hasOwn(contract.routes, item.href.split('?')[0]), `navigation has no route: ${item.href}`);
    assert.ok(!nav.has(item.href), `duplicate navigation: ${item.href}`); nav.add(item.href);
  }
  const aliases = new Set();
  const sectionIds = new Set();
  for (const slice of slices) {
    for (const [path, href] of Object.entries(slice.activeRoutes || {})) {
      assert.ok(!aliases.has(path), `duplicate active route: ${path}`); aliases.add(path);
      assert.ok(nav.has(href), `active route has no navigation: ${href}`);
    }
    for (const section of slice.sections || []) {
      assert.ok(Object.hasOwn(contract.routes, section.page), `section has no page: ${section.page}`);
      assert.ok(section.id && section.slot && typeof section.html === 'string', 'invalid slice section');
      assert.ok(!sectionIds.has(section.id), `duplicate section id: ${section.id}`); sectionIds.add(section.id);
    }
  }
  return { slices, contract, navigationItems, sectionForRoute };
}

// Discovery and assembly also accept committed bytes for source-bound artifacts.
export async function sliceOutputs(names, readSource) {
  const metadata = JSON.parse(await readSource('contracts/routes.v1.json'));
  const slices = [], fragments = [];
  for (const name of names) {
    const source = String(await readSource(`js/slices/${name}.js`));
    // Descriptors are standalone ES modules, with no imports or boot side effects.
    const { default: slice } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    assert.equal(slice.id, name, 'module filename must match slice id');
    slices.push(slice);
    fragments.push(JSON.parse(await readSource(`contracts/routes/${name}.json`)));
  }
  const result = assembleSlices(slices, fragments, metadata);
  for (const [index, slice] of slices.entries()) for (const row of fragments[index].routes || []) {
    assert.ok(slice.files?.includes(row.asset), `route asset must be owned by ${slice.id}: ${row.asset}`);
  }
  const registry = `${names.map((name, i) => `import slice${i} from "./slices/${name}.js";`).join('\n')}\nexport const slices = Object.freeze([${names.map((_, i) => `slice${i}`).join(', ')}]);\nexport const routeContract = ${JSON.stringify(result.contract)};\n`;
  return { ...result, outputs: new Map([
    ['contracts/app-routes.v1.json', Buffer.from(`${JSON.stringify(result.contract, null, 2)}\n`)],
    ['js/slices.generated.js', Buffer.from(registry)],
  ]) };
}

export async function sliceNames(root) {
  const modules = (await readdir(join(root, 'js/slices'))).filter(p => p.endsWith('.js')).map(p => p.slice(0, -3)).sort();
  const fragments = (await readdir(join(root, 'contracts/routes'))).filter(p => p.endsWith('.json')).map(p => p.slice(0, -5)).sort();
  assert.deepEqual(modules, fragments, 'every slice needs one module and one route fragment');
  assert.ok(modules.length, 'the app needs registered slices');
  return modules;
}

export async function prepareSlices(root) {
  const result = await sliceOutputs(await sliceNames(root), path => readFile(join(root, path)));
  for (const path of assertSliceOwnership(result.slices).keys()) await readFile(join(root, path));
  for (const [path, bytes] of result.outputs) await writeFile(join(root, path), bytes);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await prepareSlices(fileURLToPath(new URL('../', import.meta.url)));
  console.log(`slice check passed: ${result.slices.length} disjoint owners, ${Object.keys(result.contract.routes).length} routes`);
}
