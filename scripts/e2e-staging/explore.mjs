import { readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { explorer40 } from './explorer.mjs';
import { screens, targets } from './screens.mjs';
import { writeReport, explorationEvidence } from './report.mjs';
import { outputPath, scrubEvidence } from './sweep.mjs';
import { prepareStagingRecords } from './records.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));

const recordScopes = {
  '/': ['client', 'deal', 'lead', 'conversation', 'tour'],
  '/deals': ['client', 'deal'], '/clients': ['client', 'deal'],
  '/leads': ['lead'], '/doc-chats': ['conversation'], '/doc-chats/work': ['conversation'],
  '/doc-activity': ['conversation'], '/invoices': ['client', 'invoice'],
  '/tours': ['client', 'tour', 'deal'], '/tours/day.html': ['client', 'tour', 'deal'],
  '/calendar': ['client', 'deal', 'tour'], '/search': ['client', 'deal', 'lead'],
  '/relationships': ['client', 'lead'], '/leases': ['client', 'deal'],
};

export function explorationGoal(screen, setup) {
  const path = screen.path.split('?')[0];
  const charter = `Navigate first to ${screen.path}. Explore the ${screen.name} workspace on staging as E2E Joe. Open drawers, menus, tabs and detail screens; exercise every control and form, including delete, archive and send-draft on disposable invented records. Test empty/error recovery, keyboard and mobile layout. Record defects with steps, expected/actual behavior and screenshots. Use parked/archived filters and normal restore controls for recovery; reopen closed deals if available or create invented replacements through the UI. No browser login. Staging only. Never navigate to production or external destinations.`;
  const context = (recordScopes[path] || []).flatMap(record => {
    const row = setup.records?.[record];
    if (!row) return [];
    const recovery = (setup.needs_restore || []).filter(item => item.record === record);
    const current = recovery.find(item => item.current_name)?.current_name;
    const state = Object.fromEntries(['current_owner', 'current_phase', 'current_visibility'].flatMap(key => {
      const value = recovery.find(item => Object.hasOwn(item, key))?.[key];
      return value === undefined ? [] : [[key, value]];
    }));
    return [{ record, ...state, id: row.id || row.deal_id, ...(row.ref ? { ref: row.ref } : {}), name: (current || row.name || '').slice(0, 64), recovery: [...new Set(recovery.map(item => item.reason))] }];
  });
  const prefix = `${charter} Prepared synthetic records and recovery: `;
  // Whole entries keep the identifiers and recovery reasons intact. Names are
  // optional search hints; omit them if they would exceed the runner contract.
  let goal = prefix + JSON.stringify(context);
  if (goal.length > 2000) goal = prefix + JSON.stringify(context.map(({ name, ...row }) => row));
  if (goal.length > 2000) throw new Error('Workspace exploration context exceeds the pinned runner goal contract');
  return goal;
}

export async function exploreAll() {
  process.env.E2E_TARGET = 'staging-live';
  process.env.E2E_TELEMETRY_DISABLED = '1';
  process.env.DO_NOT_TRACK = '1';
  const output = outputPath();
  let setup = await prepareStagingRecords(output);
  const { release } = setup;
  const explore = await explorer40();
  const explorations = [], findings = [...setup.findings];
  const sweep = await readFile(join(output, 'controls.json'), 'utf8').then(JSON.parse).catch(() => ({ screens: [], release: null }));
  if (sweep.release && (sweep.release.source_commit !== release.source_commit || sweep.release.carr_source_commit !== release.carr_source_commit)) throw new Error('Sweep evidence belongs to a different staging source; rerun the sweep');
  let sequence = 0;
  const routedScreens = await screens();
  const expectedScreens = targets.reduce((count, target) => count + routedScreens.filter(screen => screen.surface === target.surface).length, 0);
  const expectedExplorations = targets.reduce((count, target) => count + routedScreens.filter(screen => screen.surface === target.surface).length * (target.name.endsWith('phone') ? 1 : 2), 0);
  for (const target of targets) for (const screen of routedScreens.filter(screen => screen.surface === target.surface)) {
    const agents = target.name.endsWith('phone') ? ['phone-reviewer'] : ['bug-hunter', 'first-time-ux'];
    for (const agent of agents) {
      setup = await prepareStagingRecords(output);
      const current = setup.release;
      if (current.source_commit !== release.source_commit || current.carr_source_commit !== release.carr_source_commit) throw new Error('Staging source changed during workspace exploration');
      const runId = `${String(++sequence).padStart(3, '0')}-${target.name}-${agent}`;
      const local = join(project, '.e2e', 'staging-live', runId);
      const destination = join(output, 'evidence', 'explore', runId);
      await mkdir(local, { recursive: true, mode: 0o700 });
      console.log(`Exploring ${target.name} ${screen.path} as ${agent}; max-steps 40`);
      const goal = explorationGoal(screen, setup);
      let status = 'ERROR', steps = 0;
      try {
        const result = await explore({ cwd: project, configPath: join(project, 'e2e.config.ts'), target: target.name, agent, session: 'staging-partner', goal, maxSteps: 40, timeoutMs: 900_000, output: relative(project, local), reporters: ['list', 'markdown'], trace: 'on', video: 'off', aiTrace: true });
        steps = result.explore.steps.length;
        status = result.explore.ended;
        const report = JSON.parse(await readFile(join(local, 'report.json'), 'utf8'));
        for (const item of result.explore.findings) {
          findings.push({
            id: `QA-V2-${runId}-${item.index}`, surface: target.surface, screen: screen.name,
            severity: item.severity >= 5 ? 'blocker' : item.severity >= 4 ? 'major' : item.severity >= 2 ? 'minor' : 'polish',
            kind: item.kind === 'warning' ? 'ux' : 'bug', title: item.title, steps: [...item.reproduction], expected: item.expected, actual: item.actual,
            evidence_path: explorationEvidence(report, item.artifactId, destination),
            source: `explore:${agent}`, suspected_area: item.path || screen.path,
          });
        }
      } catch { status = 'ERROR'; }
      scrubEvidence(local);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await cp(local, destination, { recursive: true });
      explorations.push({ target: target.name, screen: screen.name, path: screen.path, agent, steps, status, evidence: destination });
      await writeFile(join(output, 'explorations.json'), JSON.stringify(explorations, null, 2) + '\n');
      await writeReport(output, { screens: sweep.screens, explorations, release, findings, setup, expectedScreens, expectedExplorations });
      scrubEvidence(output);
      if (status === 'ERROR') throw new Error(`Exploration infrastructure failed at ${runId}. Evidence retained; no login was attempted.`);
    }
  }
  if (explorations.some(row => ['time','stuck','aborted','step-limit'].includes(row.status))) throw new Error('Some exploration goals stopped incomplete. See coverage.md.');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) exploreAll().catch(error => { console.error(error.message); process.exitCode = 1; });
