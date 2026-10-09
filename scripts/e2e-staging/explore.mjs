import { currentRun, directoryBytes, RUN_LIMITS, RunLimitError, modelCallsAllowed } from './run-limits.mjs';
import { readFile, mkdir, cp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { explorer40 } from './explorer.mjs';
import { screens, targets } from './screens.mjs';
import { writeReport, explorationEvidence } from './report.mjs';
import { outputPath, scrubEvidence } from './sweep.mjs';
import { prepareStagingRecords, assertStagingWriteCoverage } from './records.mjs';
import { createSweepRun, readSweepCheckpoint } from './resume.mjs';
import { configureExplorationModelCallBudget, createExplorationBatchPlan, formatExplorationBatchPlan, formatExplorationCallPlan } from './model-room.mjs';

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
  const charter = `Navigate first to ${screen.path}. Explore the ${screen.name} workspace on staging as E2E Joe. Open drawers, menus, tabs and detail screens; exercise every control and form, including delete, archive and send-draft on disposable invented records. Test empty/error recovery, keyboard and mobile layout. Record defects with steps, expected/actual behavior and screenshots. Use only prepared fixture records for writes. Unproved, global, account, runtime, creator and reference mutations are blocked. Record refusals as incomplete coverage. Never bypass the guard, repeat uncertain writes or create replacement records. No browser login. Staging only. Never navigate to production or external destinations.`;
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

async function exploreAllWithSignals(run) {
  run.check();
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
  let setup = await prepareStagingRecords(output, { run, signal: run.signal });
  const { release } = setup;
  const explore = pending.length > 0 ? await explorer40() : null;
  const explorations = [...schedule.completed];
  const findingMap = new Map([...(checkpoint?.findings || []), ...setup.findings].map(row => [row.id, row]));
  const findings = [...findingMap.values()];
  const sweep = createSweepRun({ targets, routedScreens, prior: checkpoint || undefined });
  sweep.assertRelease(release);
  await assertStagingWriteCoverage(output);
  const expectedExplorations = schedule.planned.length;
  const attemptID = randomUUID();
  for (const planned of pending) {
    if (run.signal.aborted) throw new Error('Exploration interrupted; resume from the saved checkpoint');
    const target = targets.find(row => row.name === planned.target);
    const screen = routedScreens.find(row => row.surface === planned.surface && row.path === planned.path);
    const { agent } = planned;
    setup = await prepareStagingRecords(output, { run, signal: run.signal });
    const current = setup.release;
    if (current.source_commit !== release.source_commit || current.carr_source_commit !== release.carr_source_commit) throw new Error('Staging source changed during workspace exploration');
    const runId = `${String(planned.sequence).padStart(3, '0')}-${target.name}-${agent}-${attemptID}`;
    const local = join(output, 'private', 'explore', runId);
    const destination = join(output, 'evidence', 'explore', runId);
    await mkdir(local, { recursive: true, mode: 0o700 });
    console.log(`Exploring ${target.name} ${screen.path} as ${agent}; max-steps ${callPlan.perGoal}`);
    const goal = explorationGoal(screen, setup);
    let status = 'ERROR', steps = 0, failure = null;
    const attempt = await runExplorationAttempt(explore, { cwd: project, configPath: join(project, 'e2e.config.ts'), target: target.name, agent, session: 'staging-partner', goal, maxSteps: callPlan.perGoal, timeoutMs: RUN_LIMITS.goalTimeoutMs, output: relative(project, local), reporters: ['list', 'markdown'], trace: 'off', video: 'off', aiTrace: false, interruptSignal: run.signal, forceSignal: run.signal });
    try {
      if (attempt.result) {
        const result = attempt.result;
        steps = result.explore.steps.length;
        status = result.explore.ended;
        await assertStagingWriteCoverage(output);
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
    } catch (error) { status = 'ERROR'; failure = error; }
    run.checkArtifacts();
    scrubEvidence(local);
    run.check();
    await mkdir(destination, { recursive: true, mode: 0o700 });
    run.reserveBytes(directoryBytes(local));
    await cp(local, destination, { recursive: true });
    run.checkArtifacts();
    explorations.push({ target: target.name, screen: screen.name, path: screen.path, agent, steps, status, evidence: destination });
    await writeReport(output, { ...sweep.snapshot(), explorations, release, findings, setup, expectedExplorations });
    if (failure) throw failure;
    if (run.signal.aborted) throw new Error('Exploration interrupted; evidence and checkpoint retained');
    if (status === 'ERROR') throw new Error(`Exploration infrastructure failed at ${runId}. Evidence retained; no login was attempted.`);
  }
  if (schedule.pending.length > pending.length) console.log(`Exploration batch complete; ${schedule.pending.length - pending.length} goals remain at the saved sweep checkpoint`);
  if (explorations.some(row => ['time','stuck','aborted','step-limit'].includes(row.status))) throw new Error('Some exploration goals stopped incomplete. See coverage.md.');
  await assertStagingWriteCoverage(output);
}

export async function exploreAll() {
  const run = currentRun();
  if (!run) throw new RunLimitError('supervisor-required');
  if (!modelCallsAllowed() || process.env.E2E_RUN_ID !== run.id) throw new RunLimitError('model-opt-in-required');
  const runSignals = createExplorationRunSignals();
  try { return await exploreAllWithSignals(run); }
  finally { runSignals.dispose(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) exploreAll().catch(error => { console.error(error.message); process.exitCode = 1; });
