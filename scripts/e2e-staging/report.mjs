import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';

export function explorationEvidence(report, artifactId, destination) {
  const attempts = [...(report.run?.results || []), ...(report.run?.serialGroups || [])].flatMap(row => row.attempts || []);
  const artifact = attempts.flatMap(attempt => attempt.artifacts || []).find(item => item.id === artifactId);
  if (!artifact?.path) return join(destination, 'report.json');
  const root = resolve(destination, 'artifacts');
  const path = resolve(root, artifact.path);
  const within = relative(root, path);
  if (within.startsWith('..') || isAbsolute(within)) throw new Error('Exploration artifact would escape the evidence tree');
  return path;
}

export function newDeadControls(controls, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.some(row => typeof row.key !== 'string' || !row.reason?.trim())) throw new Error('Every DEAD allowlist entry needs an exact key and reason');
  const allowed = new Set(allowlist.map(row => row.key));
  return controls.filter(row => row.status === 'DEAD' && !allowed.has(row.key));
}

export function sweepFindings(screens) {
  return screens.flatMap(screen => [...screen.controls.filter(row => ['DEAD','ERROR','UNREACHABLE'].includes(row.status)).map(row => ({
    id: row.key, surface: screen.surface, screen: screen.name, severity: 'minor', kind: 'bug',
    title: `${row.status}: ${row.name || row.role || 'Unnamed control'}`,
    steps: [`Open ${screen.path} on ${screen.target} with a fresh signed-in staging session.`, ...row.openers.map(name => `Open ${name}.`), `Press ${row.name || row.selector}.`, 'Observe for two seconds.'],
    expected: 'A control produces a URL change, main DOM mutation, network request, dialog/sheet/toast, focus move or aria state change.',
    actual: row.status === 'DEAD' ? 'No observable signal followed within two seconds.' : row.reason,
    evidence_path: row.evidence_path || '', source: 'run', suspected_area: `${screen.path} ${row.selector}`,
  })), ...(screen.failure ? [{
    id: `sweep/${screen.target}${screen.path}/${screen.failure.phase}/${screen.failure.code}`,
    surface: screen.surface, screen: screen.name, severity: 'major', kind: 'bug',
    title: `Automation infrastructure failure: ${screen.failure.phase} (${screen.failure.code})`,
    steps: [`Run the staging control sweep for ${screen.path} on ${screen.target}.`, ...(screen.failure.openers || []).map(name => `Open ${name}.`)],
    expected: 'The harness retains measured controls and completes screen inventory, opener replay and evidence capture.',
    actual: `The harness stopped during ${screen.failure.phase} (${screen.failure.code}); ${screen.controls.length} control results were retained.`,
    evidence_path: screen.controls.findLast(row => row.evidence_path)?.evidence_path || '',
    source: 'run', suspected_area: 'scripts/e2e-staging/controls.mjs and scripts/e2e-staging/sweep.mjs',
  }] : [])]);
}

export async function writeReport(output, { screens = [], explorations = [], release, findings = [], setup, expectedScreens = screens.length, expectedExplorations = explorations.length }) {
  await mkdir(output, { recursive: true });
  const all = [...sweepFindings(screens), ...findings];
  await writeFile(join(output, 'findings.json'), JSON.stringify(all, null, 2) + '\n');
  const controls = screens.flatMap(screen => screen.controls);
  await writeFile(join(output, 'controls.json'), JSON.stringify({ release, screens }, null, 2) + '\n');
  const rows = screens.map(screen => `| ${screen.target} | ${screen.name} (${screen.path}) | ${screen.reached ? 'reached' : 'FAILED'} | ${screen.controls.filter(c => ['OBSERVED','DEAD'].includes(c.status)).length} | ${screen.controls.filter(c => c.status === 'DEAD').length} | ${screen.controls.filter(c => c.status === 'DISABLED').length} | ${screen.controls.filter(c => ['ERROR','UNREACHABLE'].includes(c.status)).length} | ${screen.failure ? `${screen.failure.phase}: ${screen.failure.code}` : ''} |`);
  const disabled = controls.filter(c => c.status === 'DISABLED').map(c => `- ${c.target} ${c.path}: ${c.name || c.selector}: ${c.reason}`);
  const explorationRows = explorations.map(run => `| ${run.target} | ${run.screen} | ${run.agent} | ${run.steps} / 40 | ${run.status} |`);
  await writeFile(join(output, 'coverage.md'), [
    '# DoctorCRE staging-live e2e coverage', '', `Measured at ${new Date().toISOString()}. Source ${release?.source_commit || 'unverified'}.`, '',
    `${screens.filter(s => s.reached).length}/${expectedScreens} screens reached; ${controls.length} controls enumerated; ${controls.filter(c => ['OBSERVED','DEAD'].includes(c.status)).length} pressed; ${controls.filter(c => c.status === 'DEAD').length} DEAD.`, '',
    '| Target | Screen | Access | Pressed | DEAD | Disabled | Failed to press | Failure phase |', '|---|---|---|---:|---:|---:|---:|---|', ...rows, '',
    '## Disabled controls', '', ...disabled, '', '## Per-screen explorations', '', `${explorations.length}/${expectedExplorations} goals attempted.`, '', '| Target | Screen | Agent | Steps / limit | Status |', '|---|---|---|---:|---|', ...explorationRows, '',
    'Controls restore browser storage and reload the screen before each press, then replay only the opening path. Staging server mutations persist. Every phase failure, exhausted discovery queue, missing screen, failed press or disabled control without a reason fails completeness. Completed control results and evidence remain in partial reports. OBSERVED records signals, not a claim that the action is correct. Focus is placed on the target before measurement so pointer focus alone does not mask a dead action.', '',
    ...(setup ? ['## Staging record setup', '', `Normal authenticated API setup: ${setup.complete ? 'complete' : 'FAILED'}. Synthetic record receipts: staging-records.json.`, '', `Recovery needed: ${JSON.stringify(setup.needs_restore)}.`, '', 'The draft tour has no canonical property stop, so acceptance and share require an authorized property fixture. Mark-paid requires an existing invoiced commission. Outlook draft creation uses a local processor outside this staging stack. These prerequisites are not fabricated or bypassed by the runner.', ''] : []),
  ].join('\n'));
  return all;
}
