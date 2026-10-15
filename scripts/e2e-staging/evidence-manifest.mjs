import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RUN_LIMITS } from './run-limits.mjs';

const schema = 'doctorcre-staging-retained-evidence.v1';
const extensions = /\.(?:json|md|txt|png|jpe?g|webp)$/i;
const privateNames = /(?:auth|session|cookie|token|secret|storage|trace|transcript)/i;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('Retained staging evidence invalid'); };
const within = (root, path) => {
  const part = relative(root, path);
  return part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

function evidenceReferences(root, controls) {
  const refs = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'evidence_path' || key === 'evidence') && typeof child === 'string' && child) {
        const path = resolve(child);
        if (!within(join(root, 'evidence'), path)) fail();
        refs.add(relative(root, path));
      } else visit(child);
    }
  };
  visit(controls);
  return [...refs].sort();
}

async function regularBytes(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(fail);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > RUN_LIMITS.artifactBytes ||
        typeof process.getuid === 'function' && info.uid !== process.getuid()) fail();
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function filePaths(root, path) {
  const info = await lstat(path).catch(fail);
  if (info.isSymbolicLink() || typeof process.getuid === 'function' && info.uid !== process.getuid()) fail();
  if (info.isFile()) return [path];
  if (!info.isDirectory()) fail();
  const names = await readdir(path);
  if (!names.length) fail();
  const descendants = [];
  for (const name of names.sort()) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') fail();
    descendants.push(...await filePaths(root, join(path, name)));
  }
  return descendants;
}

export async function snapshotRetainedEvidence(root, controls, sourcePair, runId) {
  root = resolve(root);
  const refs = evidenceReferences(root, controls);
  const paths = new Set();
  for (const ref of refs) for (const path of await filePaths(root, join(root, ref))) paths.add(path);
  const files = {};
  let size = 0;
  for (const path of [...paths].sort()) {
    const name = relative(root, path);
    if (!name.startsWith(`evidence${sep}`) || !extensions.test(name) || privateNames.test(name) || paths.size > 10000) fail();
    const bytes = await regularBytes(path);
    size += bytes.length;
    if (size > RUN_LIMITS.artifactBytes) fail();
    files[name.split(sep).join('/')] = { size: bytes.length, sha256: hash(bytes), bytes: bytes.toString('base64') };
  }
  for (const row of controls.explorations || []) if (['completed', 'finished'].includes(row.status) &&
      !Object.hasOwn(files, relative(root, resolve(row.evidence || '')).split(sep).join('/') + '/report.json')) fail();
  return { schema, source_pair: sourcePair, source_root: root, run_id: runId,
    checkpoint_sha256: hash(Buffer.from(JSON.stringify(controls))),
    references: refs.map(ref => ref.split(sep).join('/')), files };
}

export function retainedEvidenceFiles(manifest, controls, sourcePair, runId) {
  if (manifest?.schema !== schema || !manifest.source_root || !isAbsolute(manifest.source_root) ||
      manifest.run_id !== runId ||
      manifest.checkpoint_sha256 !== hash(Buffer.from(JSON.stringify(controls))) ||
      JSON.stringify(manifest.source_pair) !== JSON.stringify(sourcePair) ||
      !Array.isArray(manifest.references) || !manifest.files || typeof manifest.files !== 'object' ||
      JSON.stringify(evidenceReferences(manifest.source_root, controls).map(ref => ref.split(sep).join('/'))) !==
        JSON.stringify(manifest.references)) fail();
  const files = new Map();
  let total = 0;
  for (const [name, meta] of Object.entries(manifest.files)) {
    if (!name.startsWith('evidence/') || name === 'evidence/manifest.json' ||
        !within(join(manifest.source_root, 'evidence'), resolve(manifest.source_root, name)) ||
        !extensions.test(name) || privateNames.test(name) || !meta || !Number.isSafeInteger(meta.size) ||
        !/^[a-f0-9]{64}$/.test(meta.sha256 || '') || typeof meta.bytes !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(meta.bytes)) fail();
    const bytes = Buffer.from(meta.bytes, 'base64');
    total += bytes.length;
    if (total > RUN_LIMITS.artifactBytes || bytes.length !== meta.size || hash(bytes) !== meta.sha256) fail();
    files.set(name, bytes);
  }
  for (const ref of manifest.references) if (!files.has(ref) &&
      ![...files.keys()].some(name => name.startsWith(ref + '/'))) fail();
  for (const row of controls.explorations || []) if (['completed', 'finished'].includes(row.status) &&
      !files.has(relative(manifest.source_root, resolve(row.evidence || '')).split(sep).join('/') + '/report.json')) fail();
  return files;
}

export function rebaseEvidenceReferences(controls, oldRoot, newRoot) {
  const copy = structuredClone(controls);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'evidence_path' || key === 'evidence') && typeof child === 'string' && child) {
        const part = relative(oldRoot, child);
        if (!within(join(oldRoot, 'evidence'), resolve(child))) fail();
        value[key] = join(newRoot, part);
      } else visit(child);
    }
  };
  visit(copy);
  return copy;
}

export async function assessCurrentEvidence(root, controls, runId) {
  try {
    const sourcePair = { source_commit: controls.release?.source_commit,
      carr_source_commit: controls.release?.carr_source_commit };
    const manifest = await snapshotRetainedEvidence(root, controls, sourcePair, runId);
    retainedEvidenceFiles(manifest, controls, sourcePair, runId);
    return Object.freeze({ schema, verified: manifest.references.length > 0, source_pair: sourcePair,
      run_id: runId, referencedFiles: Object.keys(manifest.files).length });
  } catch { return Object.freeze({ schema, verified: false }); }
}

export async function verifyRetainedEvidence(root, controls) {
  try {
    root = resolve(root);
    const manifest = JSON.parse(await regularBytes(join(root, 'evidence', 'manifest.json')));
    const budget = JSON.parse(await regularBytes(join(root, 'run-budget.json')));
    if (manifest.schema !== schema || !manifest.source_pair ||
        manifest.source_root !== root || manifest.run_id !== budget.id ||
        manifest.checkpoint_sha256 !== hash(Buffer.from(JSON.stringify(controls))) ||
        manifest.source_pair.source_commit !== controls.release?.source_commit ||
        manifest.source_pair.carr_source_commit !== controls.release?.carr_source_commit ||
        !Array.isArray(manifest.references) || !manifest.files || typeof manifest.files !== 'object') fail();
    const refs = evidenceReferences(root, controls).map(ref => ref.split(sep).join('/'));
    if (JSON.stringify(refs) !== JSON.stringify(manifest.references)) fail();
    const observed = new Set();
    for (const ref of refs) for (const path of await filePaths(root, join(root, ref)))
      observed.add(relative(root, path).split(sep).join('/'));
    if (JSON.stringify([...observed].sort()) !== JSON.stringify(Object.keys(manifest.files).sort())) fail();
    let total = 0;
    for (const [name, meta] of Object.entries(manifest.files)) {
      const path = resolve(root, name);
      if (!within(join(root, 'evidence'), path) || name === 'evidence/manifest.json' || !extensions.test(name) ||
          privateNames.test(name) ||
          !meta || !Number.isSafeInteger(meta.size) || !/^[a-f0-9]{64}$/.test(meta.sha256 || '')) fail();
      const bytes = await regularBytes(path);
      total += bytes.length;
      if (bytes.length !== meta.size || hash(bytes) !== meta.sha256 || total > RUN_LIMITS.artifactBytes) fail();
    }
    for (const ref of refs) {
      const path = resolve(root, ref), info = await lstat(path);
      if (info.isDirectory()) {
        if (!Object.hasOwn(manifest.files, ref + '/report.json') && ref.startsWith('evidence/explore/')) fail();
        if (![...Object.keys(manifest.files)].some(name => name.startsWith(ref + '/'))) fail();
      } else if (!Object.hasOwn(manifest.files, ref)) fail();
    }
    for (const row of controls.explorations || []) if (['completed', 'finished'].includes(row.status) &&
        !Object.hasOwn(manifest.files, relative(root, resolve(row.evidence || '')).split(sep).join('/') + '/report.json')) fail();
    return Object.freeze({ schema, verified: refs.length > 0, source_pair: manifest.source_pair, run_id: manifest.run_id,
      referencedFiles: Object.keys(manifest.files).length });
  } catch { return Object.freeze({ schema, verified: false }); }
}
