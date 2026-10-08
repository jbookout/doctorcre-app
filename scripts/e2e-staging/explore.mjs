import { readFile, mkdir, cp } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { explorer40 } from './explorer.mjs';
import { screens, targets } from './screens.mjs';
import { writeReport, explorationEvidence } from './report.mjs';
import { outputPath, scrubEvidence } from './sweep.mjs';
import { prepareStagingRecords } from './records.mjs';
import { createSweepRun, readSweepCheckpoint } from './resume.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));

export function buildExplorationGoal({ screen, setup }) {
  const recovery = setup.needs_restore.length > 0
    ? 'Some prepared records need recovery. Use normal UI filters and recovery controls, or create another invented record through the UI.'
    : 'Prepared records are ready for use.';
  const goal = `Navigate first to ${screen.path}. Explore every part of the ${screen.name} workspace on staging as the signed-in E2E Joe partner. Open every drawer, menu and tab. Exercise every control and form, including delete, archive and send-draft, using only disposable synthetic staging records. Test empty and error recovery, keyboard use and mobile layout. Keep this goal within the assigned workspace and follow its detail screens. Record each observed defect with reproduction steps, expected and actual behavior, and screenshots. ${recovery} Do not log in. Stay on staging and never navigate to production or an external destination.`;
  if (goal.length > 2_000) throw new Error(`Internal exploration goal exceeds the pinned 2000-character limit (${goal.length})`);
  return goal;
}

export async function runExplorationAttempt(explore, options) {
  try { return { result: await explore(options), error: null }; }
  catch (error) { return { result: null, error }; }
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
      const goal = buildExplorationGoal({ screen, setup });
      let status = 'ERROR', steps = 0, failure = null;
      const attempt = await runExplorationAttempt(explore, { cwd: project, configPath: join(project, 'e2e.config.ts'), target: target.name, agent, session: 'staging-partner', goal, maxSteps: 40, timeoutMs: 900_000, output: relative(project, local), reporters: ['list', 'markdown'], trace: 'on', video: 'off', aiTrace: true });
      if (attempt.result) {
        const result = attempt.result;
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
      } else { failure = attempt.error; }
      scrubEvidence(local);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await cp(local, destination, { recursive: true });
      explorations.push({ target: target.name, screen: screen.name, path: screen.path, agent, steps, status, evidence: destination });
      await writeReport(output, { ...sweep.snapshot(), explorations, release, findings, setup, expectedExplorations });
      if (failure) throw failure;
      if (status === 'ERROR') throw new Error(`Exploration infrastructure failed at ${runId}. Evidence retained; no login was attempted.`);
    }
  }
  if (explorations.some(row => ['time','stuck','aborted','step-limit'].includes(row.status))) throw new Error('Some exploration goals stopped incomplete. See coverage.md.');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) exploreAll().catch(error => { console.error(error.message); process.exitCode = 1; });
