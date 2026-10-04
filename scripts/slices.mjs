import { randomUUID } from "node:crypto";
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createAppLayout } from '../js/app-layout.js';
import ownership from '../contracts/slice-ownership.v1.json' with { type: 'json' };
import { registerSlices, NAVIGATION_GROUPS, createSliceSection } from '../js/slice-registration.js';

export const GENERATED_PATHS = ['contracts/app-routes.v1.json', 'js/slices.generated.js'];
const safePath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..') && posix.normalize(path) === path;
const pathname = path => typeof path === 'string' && /^\/(?!\/)[^?#]*$/.test(path);

export function assertSliceOwnership(slices, shared = ownership.shared) {
  const sharedFiles = new Set([...GENERATED_PATHS, ...shared]);
  const owners = new Map();
  for (const slice of slices) {
    assert.match(slice.id, /^[a-z][a-z0-9-]*$/, 'slice id must be a descriptive slug');
    for (const path of [`js/slices/${slice.id}.js`, `contracts/routes/${slice.id}.json`, ...(slice.files || [])]) {
      assert.ok(safePath(path), `unsafe slice file: ${path}`);
      if (owners.has(path)) throw new Error(`${path} is written by ${owners.get(path)} and ${slice.id}`);
      if (sharedFiles.has(path)) throw new Error(`shared integration file cannot be slice-owned: ${path}`);
      owners.set(path, slice.id);
    }
  }
  return owners;
}

export function assembleSlices(slices, fragments, metadata, shared = ownership.shared) {
  assertSliceOwnership(slices, shared);
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
  contract.gatePaths = Object.fromEntries(fragments.flatMap(f => f.routes || []).map(row => {
    assert.ok(pathname(row.gatePath), `route needs an admitted CARR gatePath: ${row.path}`);
    return [row.path, row.gatePath];
  }));
  const { navigationItems, sectionForRoute } = registerSlices(slices);
  const nav = new Set();
  for (const slice of slices) for (const item of slice.navigation || []) assert.ok(Number.isFinite(item.order), `navigation needs an order: ${slice.id}`);
  for (const item of navigationItems) {
    assert.ok(item.label && item.href && (item.group === undefined || NAVIGATION_GROUPS.includes(item.group)), 'invalid navigation entry');
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
      if (section.module) {
        assert.ok(section.module.startsWith('/js/') && /\.m?js$/.test(section.module) && safePath(section.module.slice(1)), `unsupported section module deployment path: ${section.module}`);
        assert.ok(slice.files?.includes(section.module.slice(1)), `section module must be owned by ${slice.id}`);
      }
      assert.ok(!sectionIds.has(section.id), `duplicate section id: ${section.id}`); sectionIds.add(section.id);
    }
  }
  return { slices, contract, navigationItems, sectionForRoute };
}

// Discovery and assembly also accept committed bytes for source-bound artifacts.
export async function sliceOutputs(names, readSource) {
  const metadata = JSON.parse(await readSource('contracts/routes.v1.json'));
  const { schema, shared } = JSON.parse(await readSource('contracts/slice-ownership.v1.json'));
  assert.equal(schema, 'doctorcre-slice-ownership.v1');
  assert.ok(Array.isArray(shared) && shared.every(safePath) && new Set(shared).size === shared.length, 'invalid shared ownership');
  const slices = [], fragments = [];
  for (const name of names) {
    const source = String(await readSource(`js/slices/${name}.js`));
    // Descriptors are standalone ES modules, with no imports or boot side effects.
    const { default: slice } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    assert.equal(slice.id, name, 'module filename must match slice id');
    slices.push(slice);
    fragments.push(JSON.parse(await readSource(`contracts/routes/${name}.json`)));
  }
  const result = assembleSlices(slices, fragments, metadata, shared);
  for (const [index, slice] of slices.entries()) for (const row of fragments[index].routes || []) {
    assert.ok(slice.files?.includes(row.asset), `route asset must be owned by ${slice.id}: ${row.asset}`);
  }
  // Parse the target artifact, including runtime layout targets, before accepting
  // selectors or IDs. JSDOM never runs page scripts or loads remote resources.
  const pages = new Map();
  for (const slice of slices) for (const section of slice.sections || []) {
    assert.notEqual(section.page, '/share', 'public report sections are not supported by the report adapter');
    let page = pages.get(section.page);
    if (!page) {
      page = new JSDOM(String(await readSource(result.contract.routes[section.page]))).window.document;
      if (page.getElementById('appShell')) {
        const { layout, status } = createAppLayout(page);
        page.body.append(layout, status);
      }
      pages.set(section.page, page);
    }
    let target;
    try { target = page.querySelector(section.slot); } catch { throw new Error(`invalid section slot: ${section.slot}`); }
    assert.ok(target && !target.closest('#appShell') && !['SCRIPT', 'STYLE'].includes(target.tagName), `missing or unsupported section slot: ${section.slot}`);
    target.append(createSliceSection(page, section));
  }
  const registry = `${names.map((name, i) => `import slice${i} from "./slices/${name}.js";`).join('\n')}\nexport const slices = Object.freeze([${names.map((_, i) => `slice${i}`).join(', ')}]);\nexport const routeContract = ${JSON.stringify(result.contract)};\n`;
  return { ...result, shared, outputs: new Map([
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
  const owners = assertSliceOwnership(result.slices, result.shared);
  for (const path of owners.keys()) await readFile(join(root, path));
  for (const directory of ['js', 'css', 'test']) {
    const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) if (entry.isFile() && /\.(?:m?js|css)$/.test(entry.name)) {
      const path = `${directory}/${entry.name}`;
      assert.ok(owners.has(path) || result.shared.includes(path) || GENERATED_PATHS.includes(path), `file needs a slice owner or shared declaration: ${path}`);
    }
  }
  for (const [path, bytes] of result.outputs) {
    const target = join(root, path);
    const current = await readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current?.equals(bytes)) continue;
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await prepareSlices(fileURLToPath(new URL('../', import.meta.url)));
  console.log(`slice check passed: ${result.slices.length} disjoint owners, ${Object.keys(result.contract.routes).length} routes`);
}
