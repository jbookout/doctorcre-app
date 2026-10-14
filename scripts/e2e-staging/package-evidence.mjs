import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPORTS = ['controls.json', 'findings.json', 'explorations.json'];
const INPUT_FILES = [...REPORTS, 'coverage.md'];
const PACKAGE_FILES = [...REPORTS, 'coverage.md', 'evidence-package.json'];
const EXCLUDED_TREES = new Set(['private', 'evidence', 'playwright']);
const EXCLUDED_FILES = new Set([
  '.run-owner', 'run.log', 'run-budget.json', 'sweep-verdict.json',
  'staging-records-plan.json', 'staging-records.json',
]);
const STRING_FIELDS = new Set([
  'key', 'target', 'path', 'name', 'surface', 'selector', 'role', 'reason',
  'status', 'phase', 'code', 'id', 'severity', 'kind', 'title', 'expected',
  'actual', 'suspected_area', 'owner', 'agent', 'source_commit',
  'carr_source_commit', 'service', 'environment', 'attempt_id',
]);
const STATUSES = new Set(['OBSERVED', 'DISABLED', 'DEAD', 'ERROR', 'UNREACHABLE', 'SKIPPED']);
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const SCRUBBER = fileURLToPath(new URL('./scrub-evidence.py', import.meta.url));

const fail = message => { throw new Error(`Evidence package refused: ${message}`); };
const isWithin = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

function cleanText(value) {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/([?&#](?:access_token|refresh_token|token|share_token|session|cookie|authorization|csrf_token|csrfToken)=)[^&#\s"'<>]*/gi, '$1[redacted]')
    .replace(/((?:__Host-[A-Za-z0-9_-]+|(?:session|sid|csrf|token)[A-Za-z0-9_-]*)=)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
}

function string(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail('a report field had the wrong type');
  return cleanText(value);
}

function strings(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail('a report list had the wrong type');
  return value.map(cleanText);
}

function number(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) fail('a report count had the wrong type');
  return value;
}

function bool(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') fail('a report flag had the wrong type');
  return value;
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    const value = source?.[key];
    if (value === undefined || value === null) continue;
    if (STRING_FIELDS.has(key)) result[key] = string(value);
    else if (key === 'signals' || key === 'openers') result[key] = strings(value);
    else if (key === 'steps') result[key] = Array.isArray(value) ? strings(value) : number(value);
    else if (['expectedScreens', 'expectedExplorations', 'expectedStates', 'retained_controls', 'handler_executions', 'known_remaining', 'max_opener_depth'].includes(key)) result[key] = number(value);
    else if (['reached', 'exhausted', 'in_progress', 'resolved', 'press_attempted', 'pending_discovery'].includes(key)) result[key] = bool(value);
  }
  return result;
}

function controlReceipt(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !STATUSES.has(row.status)) fail('a control receipt was malformed');
  const result = pick(row, ['key', 'target', 'path', 'selector', 'role', 'name', 'status', 'reason', 'signals', 'openers']);
  if (row.execution !== undefined) {
    const execution = row.execution;
    if (!execution || typeof execution !== 'object' || typeof execution.press_attempted !== 'boolean' || !Number.isSafeInteger(execution.handler_executions) || execution.handler_executions < 0) fail('a control execution receipt was malformed');
    result.execution = { press_attempted: execution.press_attempted, handler_executions: execution.handler_executions };
  }
  return result;
}

function screenReceipt(screen) {
  if (!screen || typeof screen !== 'object' || Array.isArray(screen) || !Array.isArray(screen.controls)) fail('a screen receipt was malformed');
  const result = pick(screen, ['target', 'path', 'name', 'surface', 'reached', 'exhausted', 'in_progress', 'attempt_id']);
  result.controls = screen.controls.map(controlReceipt);
  if (screen.failure !== undefined && screen.failure !== null) {
    if (typeof screen.failure !== 'object' || Array.isArray(screen.failure)) fail('a screen failure receipt was malformed');
    result.failure = pick(screen.failure, ['phase', 'code', 'retained_controls']);
  }
  if (screen.traversal !== undefined && screen.traversal !== null) {
    if (typeof screen.traversal !== 'object' || Array.isArray(screen.traversal)) fail('a traversal receipt was malformed');
    result.traversal = pick(screen.traversal, ['known_remaining', 'max_opener_depth', 'pending_discovery']);
  }
  return result;
}

function controlsReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.screens) ||
      value.stateObligations !== undefined && !Array.isArray(value.stateObligations)) fail('controls report was malformed');
  const release = value.release;
  if (!release || release.service !== 'doctorcre-app' || release.environment !== 'staging' ||
      !/^[a-f0-9]{40}$/i.test(release.source_commit || '') || !/^[a-f0-9]{40}$/i.test(release.carr_source_commit || '')) fail('controls report source binding was invalid');
  return {
    schema: 'doctorcre-staging-evidence-controls.v1',
    release: {
      service: 'doctorcre-app', environment: 'staging',
      source_commit: release.source_commit.toLowerCase(), carr_source_commit: release.carr_source_commit.toLowerCase(),
    },
    expectedScreens: number(value.expectedScreens),
    expectedExplorations: number(value.expectedExplorations),
    expectedStates: number(value.expectedStates),
    screens: value.screens.map(screenReceipt),
    stateObligations: (value.stateObligations ?? []).map(stateReceipt),
  };
}

function findingReceipt(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('a finding receipt was malformed');
  return pick(row, ['id', 'surface', 'screen', 'severity', 'kind', 'title', 'steps', 'expected', 'actual', 'suspected_area', 'resolved']);
}

function explorationReceipt(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('an exploration receipt was malformed');
  return pick(row, ['target', 'screen', 'agent', 'steps', 'status']);
}

function stateReceipt(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !row.spec || typeof row.spec !== 'object' || !Array.isArray(row.sources)) fail('a state obligation receipt was malformed');
  const result = pick(row, ['target', 'status']);
  result.spec = pick(row.spec, ['id', 'owner', 'kind']);
  result.sourceCount = row.sources.length;
  if (row.result !== undefined && row.result !== null) {
    if (typeof row.result !== 'object' || Array.isArray(row.result)) fail('a state result receipt was malformed');
    result.resultStatus = string(row.result.status);
  }
  return result;
}

async function safeDirectory(path, label) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') fail(`${label} was missing`); throw error; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} was not a real directory`);
  return await realpath(path);
}

async function readRegular(root, name) {
  const path = join(root, name);
  const before = await lstat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!before || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > MAX_REPORT_BYTES) fail(`${name} was missing, oversized, or unsafe`);
  const resolved = await realpath(path);
  if (!isWithin(root, resolved) || resolved === root) fail(`${name} escaped the source directory`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino) fail(`${name} changed while being read`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function classifySource(root) {
  const names = await readdir(root);
  const seen = new Set();
  for (const name of names) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) fail('an unsafe source entry name was found');
    const path = join(root, name), stat = await lstat(path);
    if (stat.isSymbolicLink()) fail('a symlink was found in the source root');
    if (INPUT_FILES.includes(name)) {
      if (!stat.isFile() || stat.nlink !== 1) fail(`${name} was not a regular report file`);
      seen.add(name);
    } else if (EXCLUDED_TREES.has(name) || name === '.run-budget.lock' || /^\.report-[A-Za-z0-9_-]+$/.test(name)) {
      if (!stat.isDirectory()) fail(`${name} was not a classified directory`);
    } else if (EXCLUDED_FILES.has(name) || /^run-budget\.json\.\d+\.tmp$/.test(name) || /^owned-process-groups-[0-9a-f-]{36}\.jsonl$/i.test(name)) {
      if (!stat.isFile() || stat.nlink !== 1) fail(`${name} was not a classified regular file`);
    } else fail(`unclassified source entry ${name}`);
  }
  for (const name of INPUT_FILES) if (!seen.has(name)) fail(`required report ${name} was missing`);
}

function scrubPackage(path) {
  const result = spawnSync('python3', [SCRUBBER, path], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (result.error || result.status !== 0) fail('the existing scrubber could not sanitize the typed package');
}

function summarize(controls) {
  const statuses = Object.fromEntries([...STATUSES].map(status => [status, 0]));
  const lines = ['# Sanitized staging sweep coverage', '',
    `Source: ${controls.release.source_commit}; CARR source: ${controls.release.carr_source_commit}.`, '',
    `Screens reached: ${controls.screens.filter(screen => screen.reached).length}/${controls.expectedScreens ?? controls.screens.length}.`];
  const rows = [];
  for (const screen of controls.screens) {
    for (const control of screen.controls) statuses[control.status]++;
    const local = Object.fromEntries([...STATUSES].map(status => [status, screen.controls.filter(control => control.status === status).length]));
    rows.push(`| ${screen.target ?? ''} | ${screen.name ?? ''} (${screen.path ?? ''}) | ${screen.reached ? 'reached' : 'not reached'} | ${screen.controls.length} | ${local.OBSERVED} | ${local.DEAD} | ${local.ERROR + local.UNREACHABLE} | ${local.SKIPPED} |`);
  }
  const stateCounts = controls.stateObligations.reduce((counts, row) => {
    counts[row.status] = (counts[row.status] || 0) + 1;
    return counts;
  }, {});
  lines.push(`Controls: ${Object.values(statuses).reduce((a, b) => a + b, 0)}; OBSERVED ${statuses.OBSERVED}; DEAD ${statuses.DEAD}; DISABLED ${statuses.DISABLED}; ERROR/UNREACHABLE ${statuses.ERROR + statuses.UNREACHABLE}; SKIPPED ${statuses.SKIPPED}.`,
    `State obligations: ${controls.stateObligations.length}/${controls.expectedStates ?? controls.stateObligations.length}; ${Object.entries(stateCounts).map(([status, count]) => `${status} ${count}`).join('; ') || 'none'}.`, '',
    '| Target | Screen | Reachability | Enumerated | OBSERVED | DEAD | Errors | SKIPPED |', '|---|---|---|---:|---:|---:|---:|---:|', ...rows, '',
    'OBSERVED records signals; it does not establish that the control action was correct.',
    'This package contains typed text receipts only. Browser storage, screenshots, traces, Playwright results, logs, and staging record plans are excluded.');
  return cleanText(lines.join('\n') + '\n');
}

export async function packageEvidence({ sourceDir = process.env.E2E_V2_OUTPUT, outputDir = process.env.E2E_EVIDENCE_PACKAGE } = {}) {
  if (!sourceDir || !outputDir) fail('E2E_V2_OUTPUT and E2E_EVIDENCE_PACKAGE are required');
  const sourcePath = resolve(sourceDir), outputPath = resolve(outputDir);
  if (sourcePath === outputPath || isWithin(sourcePath, outputPath) || isWithin(outputPath, sourcePath)) fail('the package directory must be outside the authenticated run directory');
  const source = await safeDirectory(sourcePath, 'the source');
  const parent = resolve(dirname(outputPath));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentReal = await realpath(parent);
  if (parentReal !== parent) fail('the package destination parent was a symlink');
  if (isWithin(source, parentReal)) fail('the package staging directory would be inside the authenticated run directory');
  const existing = await lstat(outputPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) fail('the package destination already exists');
  await classifySource(source);

  const raw = {};
  for (const name of REPORTS) raw[name] = JSON.parse((await readRegular(source, name)).toString('utf8'));
  const controls = controlsReceipt(raw['controls.json']);
  if (!Array.isArray(raw['findings.json']) || !Array.isArray(raw['explorations.json'])) fail('findings or explorations report was malformed');
  const findings = raw['findings.json'].map(findingReceipt);
  const explorations = raw['explorations.json'].map(explorationReceipt);
  const staged = await mkdtemp(join(parentReal, '.doctorcre-evidence-package-'));
  try {
    await writeFile(join(staged, 'controls.json'), JSON.stringify(controls, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(join(staged, 'findings.json'), JSON.stringify({ schema: 'doctorcre-staging-evidence-findings.v1', findings }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(join(staged, 'explorations.json'), JSON.stringify({ schema: 'doctorcre-staging-evidence-explorations.v1', explorations }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(join(staged, 'coverage.md'), summarize(controls), { mode: 0o600, flag: 'wx' });
    await writeFile(join(staged, 'evidence-package.json'), JSON.stringify({
      schema: 'doctorcre-evidence-package.v1',
      files: REPORTS.concat('coverage.md'),
      excludes: ['private browser storage', 'screenshots and video', 'Playwright reports and traces', 'logs and diagnostics', 'staging record plans and receipts'],
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    scrubPackage(staged);
    const packageEntries = await readdir(staged);
    if (packageEntries.length !== PACKAGE_FILES.length || packageEntries.some(name => !PACKAGE_FILES.includes(name))) fail('the staged package contained an unclassified entry');
    for (const name of PACKAGE_FILES) {
      const stat = await lstat(join(staged, name));
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail(`staged ${name} was unsafe`);
    }
    // Reparse scrubbed JSON so the published package is both sanitized and valid.
    for (const name of REPORTS) JSON.parse(await readFile(join(staged, name), 'utf8'));
    await rename(staged, outputPath);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
  return { outputDir: outputPath, files: PACKAGE_FILES };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageEvidence().then(({ outputDir, files }) => console.log(`Sanitized staging evidence package created: ${files.length} files at ${outputDir}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
