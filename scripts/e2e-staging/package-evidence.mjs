import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
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
const STATUSES = new Set(['OBSERVED', 'DISABLED', 'DEAD', 'ERROR', 'UNREACHABLE', 'SKIPPED']);
const STATE_STATUSES = new Set(['pending', 'passed', 'failed']);
const RESULT_STATUSES = new Set([...STATUSES, 'pending', 'passed', 'failed']);
const EXPLORATION_STATUSES = new Set(['completed', 'finished', 'complete', 'time', 'stuck', 'aborted', 'step-limit', 'ERROR']);
const FINDING_SEVERITIES = new Set(['blocker', 'major', 'minor', 'polish']);
const FINDING_KINDS = new Set(['bug', 'ux']);
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

const fail = message => { throw new Error(`Evidence package refused: ${message}`); };
const isWithin = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

function number(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) fail('a report count was outside its safe range');
  return value;
}

function bool(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') fail('a report flag had the wrong type');
  return value;
}

function countStatuses(rows, allowed, label) {
  const counts = Object.fromEntries([...allowed].map(status => [status, 0]));
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !allowed.has(row.status)) fail(`a ${label} status was malformed`);
    counts[row.status]++;
  }
  return counts;
}

function screenReceipt(screen, index) {
  if (!screen || typeof screen !== 'object' || Array.isArray(screen) || !Array.isArray(screen.controls)) fail('a screen receipt was malformed');
  const statusCounts = countStatuses(screen.controls, STATUSES, 'control');
  let pressAttempts = 0, handlerExecutions = 0;
  for (const control of screen.controls) {
    if (control.execution === undefined) continue;
    const execution = control.execution;
    if (!execution || typeof execution !== 'object' || typeof execution.press_attempted !== 'boolean' || !Number.isSafeInteger(execution.handler_executions) || execution.handler_executions < 0) fail('a control execution receipt was malformed');
    pressAttempts += Number(execution.press_attempted);
    handlerExecutions += execution.handler_executions;
  }
  const result = {
    ordinal: index + 1,
    reached: bool(screen.reached) ?? false,
    inProgress: bool(screen.in_progress) ?? false,
    controlCount: screen.controls.length,
    statusCounts,
    pressAttempts,
    handlerExecutions,
  };
  if (screen.traversal !== undefined && screen.traversal !== null) {
    if (typeof screen.traversal !== 'object' || Array.isArray(screen.traversal)) fail('a traversal receipt was malformed');
    result.traversal = {
      knownRemaining: number(screen.traversal.known_remaining) ?? 0,
      maxOpenerDepth: number(screen.traversal.max_opener_depth) ?? 0,
      pendingDiscovery: bool(screen.traversal.pending_discovery) ?? false,
    };
  }
  return result;
}

function stateSummary(rows) {
  if (!Array.isArray(rows)) fail('state obligations were malformed');
  const statusCounts = countStatuses(rows, STATE_STATUSES, 'state obligation');
  const resultStatusCounts = Object.fromEntries([...RESULT_STATUSES].map(status => [status, 0]));
  let sourceCount = 0;
  for (const row of rows) {
    if (!Array.isArray(row.sources)) fail('a state obligation source list was malformed');
    sourceCount += row.sources.length;
    if (row.result?.status !== undefined) {
      if (!RESULT_STATUSES.has(row.result.status)) fail('a state result status was malformed');
      resultStatusCounts[row.result.status]++;
    }
  }
  return { count: rows.length, statusCounts, resultStatusCounts, sourceCount };
}

function findingsSummary(rows) {
  if (!Array.isArray(rows)) fail('findings report was malformed');
  const severityCounts = Object.fromEntries([...FINDING_SEVERITIES].map(value => [value, 0]));
  const kindCounts = Object.fromEntries([...FINDING_KINDS].map(value => [value, 0]));
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !FINDING_SEVERITIES.has(row.severity) || !FINDING_KINDS.has(row.kind)) fail('a finding classification was malformed');
    severityCounts[row.severity]++;
    kindCounts[row.kind]++;
  }
  return { count: rows.length, severityCounts, kindCounts };
}

function explorationsSummary(rows) {
  if (!Array.isArray(rows)) fail('explorations report was malformed');
  const statusCounts = Object.fromEntries([...EXPLORATION_STATUSES].map(value => [value, 0]));
  let steps = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !EXPLORATION_STATUSES.has(row.status)) fail('an exploration status was malformed');
    statusCounts[row.status]++;
    steps += number(row.steps) ?? 0;
  }
  return { attempted: rows.length, steps, statusCounts };
}

function controlsReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.screens) ||
      value.stateObligations !== undefined && !Array.isArray(value.stateObligations)) fail('controls report was malformed');
  const release = value.release;
  if (!release || release.service !== 'doctorcre-app' || release.environment !== 'staging' ||
      !/^[a-f0-9]{40}$/i.test(release.source_commit || '') || !/^[a-f0-9]{40}$/i.test(release.carr_source_commit || '')) fail('controls report source binding was invalid');
  return {
    schema: 'doctorcre-staging-evidence-controls.v2',
    release: {
      service: 'doctorcre-app', environment: 'staging',
      source_commit: release.source_commit.toLowerCase(), carr_source_commit: release.carr_source_commit.toLowerCase(),
    },
    expectedScreens: number(value.expectedScreens),
    expectedExplorations: number(value.expectedExplorations),
    expectedStates: number(value.expectedStates),
    screens: value.screens.map(screenReceipt),
    stateObligations: stateSummary(value.stateObligations ?? []),
  };
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

function summarize(controls, findings, explorations) {
  const statuses = Object.fromEntries([...STATUSES].map(status => [status, 0]));
  for (const screen of controls.screens) for (const [status, count] of Object.entries(screen.statusCounts)) statuses[status] += count;
  const stateStatuses = controls.stateObligations.statusCounts;
  const lines = ['# Sanitized staging sweep coverage', '',
    `Source: ${controls.release.source_commit}; CARR source: ${controls.release.carr_source_commit}.`, '',
    `Screens reached: ${controls.screens.filter(screen => screen.reached).length}/${controls.expectedScreens ?? controls.screens.length}.`,
    `Controls enumerated: ${controls.screens.reduce((sum, screen) => sum + screen.controlCount, 0)}; OBSERVED ${statuses.OBSERVED}; DEAD ${statuses.DEAD}; DISABLED ${statuses.DISABLED}; ERROR/UNREACHABLE ${statuses.ERROR + statuses.UNREACHABLE}; SKIPPED ${statuses.SKIPPED}.`,
    `State obligations: ${controls.stateObligations.count}/${controls.expectedStates ?? controls.stateObligations.count}; passed ${stateStatuses.passed}; failed ${stateStatuses.failed}; pending ${stateStatuses.pending}; source references ${controls.stateObligations.sourceCount}.`, ''];
  lines.push('| Screen ordinal | Reachability | Enumerated | OBSERVED | DEAD | Disabled | Errors | Skipped |', '|---:|---|---:|---:|---:|---:|---:|---:|');
  for (const screen of controls.screens) lines.push(`| ${screen.ordinal} | ${screen.reached ? 'reached' : 'not reached'} | ${screen.controlCount} | ${screen.statusCounts.OBSERVED} | ${screen.statusCounts.DEAD} | ${screen.statusCounts.DISABLED} | ${screen.statusCounts.ERROR + screen.statusCounts.UNREACHABLE} | ${screen.statusCounts.SKIPPED} |`);
  lines.push('', `Explorations attempted: ${explorations.attempted}/${controls.expectedExplorations ?? explorations.attempted}; steps ${explorations.steps}.`,
    `Findings: ${findings.count}; blocker ${findings.severityCounts.blocker}; major ${findings.severityCounts.major}; minor ${findings.severityCounts.minor}; polish ${findings.severityCounts.polish}.`, '',
    'OBSERVED records signals; it does not establish that the control action was correct.',
    'This package contains aggregate typed receipts only. Free text, record identifiers, browser storage, screenshots, traces, Playwright results, logs, and staging record plans are excluded.');
  return lines.join('\n') + '\n';
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
  const findings = findingsSummary(raw['findings.json']);
  const explorations = explorationsSummary(raw['explorations.json']);
  const staged = await mkdtemp(join(parentReal, '.doctorcre-evidence-package-'));
  try {
    await writeFile(join(staged, 'controls.json'), JSON.stringify(controls, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(join(staged, 'findings.json'), JSON.stringify({ schema: 'doctorcre-staging-evidence-findings.v2', ...findings }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(join(staged, 'explorations.json'), JSON.stringify({ schema: 'doctorcre-staging-evidence-explorations.v2', ...explorations }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await writeFile(join(staged, 'coverage.md'), summarize(controls, findings, explorations), { mode: 0o600, flag: 'wx' });
    await writeFile(join(staged, 'evidence-package.json'), JSON.stringify({
      schema: 'doctorcre-evidence-package.v2',
      files: REPORTS.concat('coverage.md'),
      excludes: ['private browser storage', 'screenshots and video', 'Playwright reports and traces', 'logs and diagnostics', 'staging record plans and receipts'],
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
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
