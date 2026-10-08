// The model-driven workspace exploration, funded only by an authorized
// sweep-explore run. Host headroom is checked before the authorization opens;
// the open run is made active so the e2e SDK's staging targets, browser
// contexts and agent models all charge it; setup and the release check run
// through charged paths; and the first goal that ends incomplete stops the run.
import { readFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { explorer40 } from './explorer.mjs';
import { screens, targets } from './screens.mjs';
import { writeReport, explorationEvidence } from './report.mjs';
import { outputPath, scrubEvidence } from './sweep.mjs';
import { prepareStagingRecords } from './records.mjs';
import { createSweepRun, readSweepCheckpoint } from './resume.mjs';
import { BUDGET_DIR, BudgetRefusal, SWEEP_EXPLORE, setActiveBudget } from './run-budget.mjs';
import { HOST_PROBE, openWithHeadroom } from './host-headroom.mjs';
import { checkStagingRelease, stagingSession, STAGING_ORIGIN } from './session.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const INCOMPLETE = new Set(['time', 'stuck', 'aborted', 'step-limit']);

export async function exploreAll({
  loadExplorer = explorer40, prepareRecords = prepareStagingRecords, host = HOST_PROBE, budgetDir = BUDGET_DIR,
  output = outputPath(), checkRelease, clock,
} = {}) {
  const budget = await openWithHeadroom({ dir: budgetDir, profile: SWEEP_EXPLORE.name, host, clock });
  setActiveBudget(budget);
  const explorations = [];
  let failure = null;
  try {
    process.env.E2E_TARGET = 'staging-live';
    process.env.E2E_TELEMETRY_DISABLED = '1';
    process.env.DO_NOT_TRACK = '1';
    const recheck = checkRelease || (() => checkStagingRelease(budget));
    const setup = await prepareRecords(output, { budget, session: origin => stagingSession(origin, { budget }) });
    const { release } = setup;
    const findings = [...setup.findings];
    const explore = await loadExplorer();
    let sequence = 0;
    const routedScreens = await screens();
    const checkpoint = await readSweepCheckpoint(output);
    const sweep = createSweepRun({ targets, routedScreens, prior: checkpoint || undefined });
    sweep.assertRelease(release);
    const expectedExplorations = targets.reduce((count, target) => count + routedScreens.filter(screen => screen.surface === target.surface).length * (target.name.endsWith('phone') ? 1 : 2), 0);
    for (const target of targets) {
      await budget.reserve('target');
      for (const screen of routedScreens.filter(screen => screen.surface === target.surface)) {
        const agents = target.name.endsWith('phone') ? ['phone-reviewer'] : ['bug-hunter', 'first-time-ux'];
        for (const agent of agents) {
          const current = await recheck(STAGING_ORIGIN);
          if (current.source_commit !== release.source_commit || current.carr_source_commit !== release.carr_source_commit)
            throw new BudgetRefusal('source-pair-changed');
          const runId = `${String(++sequence).padStart(3, '0')}-${target.name}-${agent}`;
          const relativeDir = join('explore', runId);
          const local = join(budget.evidenceDir, relativeDir);
          await mkdir(local, { recursive: true, mode: 0o700 });
          const goal = `Navigate first to ${screen.path}. Explore the ${screen.name} workspace on staging as the signed-in E2E Joe partner. Open every drawer, menu and tab and exercise its controls. Only change the prepared synthetic records listed here; any other write is refused and stops the run. Test empty/error recovery, keyboard and mobile layout. Keep this goal scoped to this workspace; follow its detail screens. Record every observed defect with steps, expected/actual behavior and screenshots. Prepared synthetic records: ${JSON.stringify(setup.records)}. Records needing recovery: ${JSON.stringify(setup.needs_restore)}. Do not create records. No browser login. Staging only. Never navigate to production or external destinations.`;
          let status = 'ERROR', steps = 0;
          try {
            const result = await explore({ cwd: project, configPath: join(project, 'e2e.config.ts'), target: target.name, agent, session: 'staging-partner', goal,
              maxSteps: 40, timeoutMs: budget.timeoutMs(900_000), output: relative(project, local), reporters: ['list', 'markdown'], trace: 'off', video: 'off', aiTrace: false });
            steps = result.explore.steps.length;
            status = result.explore.ended;
            const report = JSON.parse(await readFile(join(local, 'report.json'), 'utf8'));
            for (const item of result.explore.findings) {
              findings.push({
                id: `QA-V2-${runId}-${item.index}`, surface: target.surface, screen: screen.name,
                severity: item.severity >= 5 ? 'blocker' : item.severity >= 4 ? 'major' : item.severity >= 2 ? 'minor' : 'polish',
                kind: item.kind === 'warning' ? 'ux' : 'bug', title: item.title, steps: [...item.reproduction], expected: item.expected, actual: item.actual,
                evidence_path: explorationEvidence(report, item.artifactId, local),
                source: `explore:${agent}`, suspected_area: item.path || screen.path,
              });
            }
          } catch (error) { if (error instanceof BudgetRefusal) throw error; status = 'ERROR'; }
          // The runner wrote its output itself; it is charged now, before anything reads it further.
          await budget.admitWritten(relativeDir);
          scrubEvidence(local);
          explorations.push({ target: target.name, screen: screen.name, path: screen.path, agent, steps, status, evidence: local });
          await writeReport(output, { ...sweep.snapshot(), explorations, release, findings, setup, expectedExplorations });
          if (status === 'ERROR' || INCOMPLETE.has(status)) throw new BudgetRefusal('exploration-' + String(status).toLowerCase());
        }
      }
    }
  } catch (error) {
    failure = error instanceof BudgetRefusal ? { phase: 'budget', code: error.code } : { phase: 'exploration', code: 'unexpected-failure' };
    await budget.stop(failure.code).catch(() => {});
    throw error instanceof BudgetRefusal ? error : new BudgetRefusal('exploration-unexpected-failure');
  } finally {
    await budget.finish({ schema: 'sweep-explore-receipt.v1', kind: 'exploration', qualified: !failure, explorations: explorations.length, failure }).catch(() => {});
    setActiveBudget(null);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) exploreAll().catch(error => { console.error(error.message); process.exitCode = 1; });
