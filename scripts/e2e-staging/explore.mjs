import { readFile, mkdir, cp } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { explorer40 } from './explorer.mjs';
import { screens, targets } from './screens.mjs';
import { writeReport, explorationEvidence } from './report.mjs';
import { outputPath, scrubEvidence } from './sweep.mjs';
import { prepareStagingRecords } from './records.mjs';
import { createSweepRun, readSweepCheckpoint } from './resume.mjs';
import { configureExplorationModelCallBudget, createExplorationBatchPlan, formatExplorationBatchPlan, formatExplorationCallPlan } from './model-room.mjs';

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

export function createExplorationRunSignals(events = process) {
  const interrupt = new AbortController();
  const force = new AbortController();
  const stop = () => {
    if (!interrupt.signal.aborted) interrupt.abort();
    else if (!force.signal.aborted) force.abort();
  };
  events.on('SIGINT', stop);
  events.on('SIGTERM', stop);
  return Object.freeze({
    interruptSignal: interrupt.signal,
    forceSignal: force.signal,
    dispose() {
      events.off('SIGINT', stop);
      events.off('SIGTERM', stop);
    },
  });
}

const explorationKey = row => JSON.stringify([row.target, row.path, row.agent]);

export function createExplorationSchedule({ targets: targetSet, routedScreens, prior = [] }) {
  let sequence = 0;
  const planned = targetSet.flatMap(target => routedScreens.filter(screen => screen.surface === target.surface).flatMap(screen => {
    const agents = target.name.endsWith('phone') ? ['phone-reviewer'] : ['bug-hunter', 'first-time-ux'];
    return agents.map(agent => ({
      sequence: ++sequence,
      target: target.name,
      surface: target.surface,
      screen: screen.name,
      path: screen.path,
      agent,
    }));
  }));
  const current = new Map(prior.map(row => [explorationKey(row), row]));
  const completed = planned.flatMap(row => ['completed', 'finished'].includes(current.get(explorationKey(row))?.status) ? [current.get(explorationKey(row))] : []);
  const completeKeys = new Set(completed.map(explorationKey));
  return Object.freeze({ planned, completed, pending: planned.filter(row => !completeKeys.has(explorationKey(row))) });
}

async function exploreAllWithSignals(runSignals) {
  process.env.E2E_TARGET = 'staging-live';
  process.env.E2E_TELEMETRY_DISABLED = '1';
  process.env.DO_NOT_TRACK = '1';
  const output = outputPath();
  const routedScreens = await screens();
  const checkpoint = await readSweepCheckpoint(output);
  const schedule = createExplorationSchedule({ targets, routedScreens, prior: checkpoint?.explorations });
  const batchPlan = createExplorationBatchPlan(schedule.pending.length);
  console.log(formatExplorationBatchPlan(batchPlan));
  const pending = schedule.pending.slice(0, batchPlan.batches[0]?.goalCount || 0);
  const callPlan = configureExplorationModelCallBudget(pending.length);
  console.log(formatExplorationCallPlan(callPlan));
  let setup = await prepareStagingRecords(output);
  const { release } = setup;
  const explore = pending.length > 0 ? await explorer40() : null;
  const explorations = [...schedule.completed];
  const findingMap = new Map([...(checkpoint?.findings || []), ...setup.findings].map(row => [row.id, row]));
  const findings = [...findingMap.values()];
  const sweep = createSweepRun({ targets, routedScreens, prior: checkpoint || undefined });
  sweep.assertRelease(release);
  const expectedExplorations = schedule.planned.length;
  for (const planned of pending) {
    const target = targets.find(row => row.name === planned.target);
    const screen = routedScreens.find(row => row.surface === planned.surface && row.path === planned.path);
    const { agent } = planned;
    setup = await prepareStagingRecords(output);
    const current = setup.release;
    if (current.source_commit !== release.source_commit || current.carr_source_commit !== release.carr_source_commit) throw new Error('Staging source changed during workspace exploration');
    const runId = `${String(planned.sequence).padStart(3, '0')}-${target.name}-${agent}`;
    const local = join(project, '.e2e', 'staging-live', runId);
    const destination = join(output, 'evidence', 'explore', runId);
    await mkdir(local, { recursive: true, mode: 0o700 });
    console.log(`Exploring ${target.name} ${screen.path} as ${agent}; max-steps ${callPlan.perGoal}`);
    const goal = buildExplorationGoal({ screen, setup });
    let status = 'ERROR', steps = 0, failure = null;
    const attempt = await runExplorationAttempt(explore, { cwd: project, configPath: join(project, 'e2e.config.ts'), target: target.name, agent, session: 'staging-partner', goal, maxSteps: callPlan.perGoal, timeoutMs: 900_000, output: relative(project, local), reporters: ['list', 'markdown'], trace: 'on', video: 'off', aiTrace: true, interruptSignal: runSignals.interruptSignal, forceSignal: runSignals.forceSignal });
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
  if (schedule.pending.length > pending.length) console.log(`Exploration batch complete; ${schedule.pending.length - pending.length} goals remain at the saved sweep checkpoint`);
  if (explorations.some(row => ['time','stuck','aborted','step-limit'].includes(row.status))) throw new Error('Some exploration goals stopped incomplete. See coverage.md.');
}

export async function exploreAll() {
  const runSignals = createExplorationRunSignals();
  try { return await exploreAllWithSignals(runSignals); }
  finally { runSignals.dispose(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) exploreAll().catch(error => { console.error(error.message); process.exitCode = 1; });
