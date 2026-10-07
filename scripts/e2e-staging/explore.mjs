import { readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { explorer40 } from './explorer.mjs';
import { screens, targets } from './screens.mjs';
import { writeReport, explorationEvidence } from './report.mjs';
import { outputPath, scrubEvidence } from './sweep.mjs';
import { prepareStagingRecords } from './records.mjs';
import { createSweepRun, readSweepCheckpoint } from './resume.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));

export async function exploreAll() {
  process.env.E2E_TARGET = 'staging-live';
  process.env.E2E_TELEMETRY_DISABLED = '1';
  process.env.DO_NOT_TRACK = '1';
  const output = outputPath();
  let setup = await prepareStagingRecords(output);
  const { release } = setup;
  const explore = await explorer40();
  const explorations = [], findings = [...setup.findings];
  let sequence = 0;
  const routedScreens = await screens();
  const checkpoint = await readSweepCheckpoint(output);
  const sweep = createSweepRun({ targets, routedScreens, prior: checkpoint || undefined });
  sweep.assertRelease(release);
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
      const goal = `Navigate first to ${screen.path}. Explore every part of the ${screen.name} workspace on staging as the signed-in E2E Joe partner. Open every drawer, menu and tab, exercise every control and form including delete, archive and send-draft on disposable staging records. Test empty/error recovery, keyboard and mobile layout. Keep this one goal scoped to this workspace; follow its detail screens. Record every observed defect with steps, expected/actual behavior and screenshots. Prepared synthetic records: ${JSON.stringify(setup.records)}. Records needing recovery after the control sweep: ${JSON.stringify(setup.needs_restore)}. Use the normal parked or archived filters and restore controls when needed to reach their details; create additional invented records through the UI if this workspace needs them. No browser login. Staging only. Never navigate to production or external destinations.`;
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
      await writeReport(output, { ...sweep.snapshot(), explorations, release, findings, setup, expectedExplorations });
      scrubEvidence(output);
      if (status === 'ERROR') throw new Error(`Exploration infrastructure failed at ${runId}. Evidence retained; no login was attempted.`);
    }
  }
  if (explorations.some(row => ['time','stuck','aborted','step-limit'].includes(row.status))) throw new Error('Some exploration goals stopped incomplete. See coverage.md.');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) exploreAll().catch(error => { console.error(error.message); process.exitCode = 1; });
