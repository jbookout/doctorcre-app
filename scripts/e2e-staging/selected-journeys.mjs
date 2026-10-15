import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { assertCheckout, assertSourcePair, businessWorkerFailureCode, cleanupPreservingPrimary, retainJourneyQualification } from './continue-run.mjs';
import { currentRun } from './run-limits.mjs';
import { stagingSession, STAGING_ORIGIN } from './session.mjs';

const refusal = code => { throw Object.assign(new Error(`Staging continuation refused: ${code}`), { code }); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const selectedActionRequirements = Object.freeze({
  W4: ['eight-columns', 'drag-cancel', 'drag-confirm', 'independent-phase-readback']
    .map(action => ['W4', 'local-deals', action]),
  W9: ['date-dialog-cancel', 'contract-date-write', 'countdown', 'date-control-removed']
    .map(action => ['W9', 'deal-timeline', action]),
});
const readbackCheckpoints = Object.freeze({
  'deal-readback-shape': ['id_matches', 'events_array', 'dates_array'],
  'w4-initial-phase': ['phase_matches'],
  'w4-cancel-phase': ['phase_matches'],
  'w4-cancel-history': ['history_matches'],
});

export function selectedJourneyDiagnostic(checkpoint, { runId, sourcePair, facts } = {}) {
  const allowed = readbackCheckpoints[checkpoint];
  if (!allowed || !uuid(runId) || !/^[0-9a-f]{40}$/.test(sourcePair?.source_commit || '') ||
      !/^[0-9a-f]{40}$/.test(sourcePair?.carr_source_commit || '') || !facts ||
      Object.keys(facts).length !== allowed.length || allowed.some(key => typeof facts[key] !== 'boolean'))
    throw new Error('selected-journey-diagnostic-invalid');
  return { schema: 'doctorcre-selected-journey-readback-diagnostic.v1', run_id: runId,
    source_pair: { source_commit: sourcePair.source_commit, carr_source_commit: sourcePair.carr_source_commit },
    checkpoint, checks: Object.fromEntries(allowed.map(key => [key, facts[key]])) };
}

async function retainReadbackDiagnostic(run, binding, checkpoint, facts) {
  if (!readbackCheckpoints[checkpoint]) return;
  try {
    const diagnostic = selectedJourneyDiagnostic(checkpoint, { runId: run.snapshot().id,
      sourcePair: { source_commit: binding.app, carr_source_commit: binding.carr }, facts });
    const path = join(run.root, 'private', 'selected-journey-readback.json');
    await mkdir(join(run.root, 'private'), { recursive: true, mode: 0o700 });
    await run.writeFile(path, JSON.stringify(diagnostic) + '\n',
      (destination, bytes) => writeFile(destination, bytes, { mode: 0o600, flag: 'wx' }));
  } catch { /* Failure diagnostics are best effort and never replace the original refusal. */ }
}

export function missingSelectedActionProofs(journeys, rows, { sourcePair, runId, fixtureRun } = {}) {
  const observed = new Set((rows || []).filter(row => row?.state === 'observed' &&
    row.source_pair?.source_commit === sourcePair?.source_commit &&
    row.source_pair?.carr_source_commit === sourcePair?.carr_source_commit &&
    row.run_id === runId && row.fixture_run === fixtureRun)
    .map(row => JSON.stringify([row.id, row.case, row.action])));
  return journeys.flatMap(id => selectedActionRequirements[id]
    .filter(identity => !observed.has(JSON.stringify(identity)))
    .map(([journey, caseId, action]) => `${journey}:${caseId}:${action}`));
}

export function mergeSelectedActionProofs(priorRows, currentRows, journeys) {
  const replacing = new Set(journeys.flatMap(id => selectedActionRequirements[id]).map(identity => JSON.stringify(identity)));
  const rows = [...(priorRows || []).filter(row => !replacing.has(JSON.stringify([row.id, row.case, row.action]))),
    ...(currentRows || [])];
  const identities = new Set();
  for (const row of rows) {
    const identity = JSON.stringify([row.id, row.case, row.action]);
    if (identities.has(identity)) refusal('selected-journey-proof-conflict');
    identities.add(identity);
  }
  return rows;
}

async function readPrivatePlan(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { refusal('selected-journey-plan-required'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16 * 1024 * 1024)
      refusal('selected-journey-plan-invalid');
    return JSON.parse(await handle.readFile());
  } catch (error) { if (error?.code?.startsWith('selected-journey')) throw error; refusal('selected-journey-plan-invalid'); }
  finally { await handle.close(); }
}

export function parseJourneySelection(value = 'W4,W9') {
  if (typeof value !== 'string' || !value) refusal('selected-journey-selection-invalid');
  const journeys = value.split(',');
  if (!journeys.length || new Set(journeys).size !== journeys.length ||
      journeys.some(id => !['W4', 'W9'].includes(id))) refusal('selected-journey-selection-invalid');
  return journeys;
}

function readonlyPending(release, plan) {
  return { schema: 'staging-readonly-journey-result.v1', full_v1_qualified: false,
    provenance: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit, run: plan.run },
    journeys: ['W1', 'W2', 'W5', 'W14'].map(journey => ({ journey, state: 'pending' })),
    counts: { carr_record_mutations: 0 } };
}

export async function runSelectedJourneys({ binding, run = currentRun(), environment = process.env } = {}) {
  const journeys = parseJourneySelection(environment.E2E_STAGING_JOURNEYS || 'W4,W9');
  const { assertStagingWriteCoverage, stagingFixtureWriteGuard, prepareStagingRecords } = await import('./records.mjs');
  const { createFreshPageFactory } = await import('./playwright-fixtures.mjs');
  const { screens, targets } = await import('./screens.mjs');
  run.check();
  await assertCheckout(binding.checkout);
  const planPath = join(run.root, 'staging-records-plan.json');
  let plan, state, release;
  try { plan = await readPrivatePlan(planPath); }
  catch (error) {
    if (error.code !== 'selected-journey-plan-required') throw error;
    const prepared = await prepareStagingRecords(run.root, { run, signal: run.signal,
      session: async (origin, options) => {
        const authenticated = await stagingSession(origin, options);
        assertSourcePair(authenticated.release, binding);
        return authenticated;
      } });
    plan = await readPrivatePlan(planPath);
    state = prepared.state;
    release = prepared.release;
  }
  await assertStagingWriteCoverage(run.root);
  const { assertJourneyQualification } = await import('./continue-run.mjs');
  const deal = plan.records?.deal?.id;
  if (plan.schema !== 'doctorcre-staging-records-plan.v1' || plan.state !== 'complete' || plan.inflight ||
      plan.origin !== STAGING_ORIGIN || plan.release?.source_commit !== binding.app ||
      plan.release?.carr_source_commit !== binding.carr || !uuid(plan.run) || !uuid(deal) ||
      plan.receipts?.deal?.deal_id !== deal || plan.automatic_phase_fixture ||
      plan.journey_qualification && plan.journey_qualification.run_id !== run.snapshot().id)
    refusal('selected-journey-plan-invalid');
  const prior = plan.journey_qualification
    ? assertJourneyQualification(plan.journey_qualification, binding, run.snapshot().id) : null;
  if (!state || !release) {
    const authenticated = await stagingSession(contract.origin, { run });
    state = authenticated.state;
    release = authenticated.release;
  }
  assertSourcePair(release, binding);
  const fixtureGuard = stagingFixtureWriteGuard({ output: run.root, release, run });
  const target = targets.find(row => row.name === 'staging-live');
  const screen = (await screens()).find(row => row.path === '/deals' && row.surface === 'app');
  if (!target || !screen) refusal('selected-journey-route-unavailable');
  const browser = await (await import('playwright')).chromium.launch();
  const removeStop = run.onStop(() => browser.close());
  const factory = createFreshPageFactory({ run,
    browser: { newContext: options => browser.newContext({ ...options, storageState: state, serviceWorkers: 'block' }) },
    releaseProbe: async () => {
      const actual = await (await import('./session.mjs')).stagingRelease(undefined, contract.origin, { run });
      assertSourcePair(actual, binding);
      return actual;
    } });
  const completed = [], steps = [], actions = [];
  let primaryError;
  try {
    const page = await factory.freshPage({ target, screen, release, fixtureGuard, path: `/deals?deal=${encodeURIComponent(deal)}` });
    const { runBusinessJourneys } = await import('./business-journeys.mjs');
    let activeJourney = 'setup', result;
    try { result = await runBusinessJourneys({ page, fixtureGuard, release, deal, run, journeys,
      onJourneyStart: id => { activeJourney = id; },
      onJourneyComplete: async progress => {
        const preservedIds = prior?.observations?.filter(row => row?.state === 'observed').map(row => row.id) || [];
        completed.splice(0, completed.length, ...new Set([
          ...['W4', 'W9', 'W15'].filter(id => prior?.business?.[id]), ...progress.completed,
        ]));
        steps.splice(0, steps.length,
          ...[...new Set(preservedIds)].map(journey => ({ journey, step: 'retained-action-proof', state: 'previously-observed' })),
          ...progress.steps);
        actions.splice(0, actions.length, ...mergeSelectedActionProofs(prior?.observations, progress.actions, journeys));
        await retainJourneyQualification({ run, binding, release, preservePriorTourReadonly: true,
          result: { completed, steps, actions,
          full_v1_qualified: false, tour: { full_v1_qualified: false },
          companions: prior?.companions || [], readonly: prior
            ? { ...readonlyPending(release, plan), journeys: readonlyPending(release, plan).journeys.map(row =>
              ({ ...row, state: prior.readonly[row.journey] })) }
            : readonlyPending(release, plan) } });
      } }); }
    catch (error) {
      await retainReadbackDiagnostic(run, binding, error?.checkpoint, error?.checkpoint_facts);
      if (error?.code && ['business-journey-receipt-missing', 'business-journey-selector-unavailable',
          'business-journey-readback-incomplete', 'business-journey-settlement-unverified',
          'presence-settlement-timeout', 'selected-journey-proof-conflict'].includes(error.code) ||
          error?.constructor?.name === 'RunLimitError') throw error;
      refusal(`selected-journey-${activeJourney.toLowerCase()}-failed`);
    }
    await fixtureGuard.assertCoverage();
    await assertStagingWriteCoverage(run.root);
    if (result?.full_v1_qualified !== false) refusal('business-result-unqualified');
    const missing = missingSelectedActionProofs(journeys, [...(prior?.observations || []), ...result.actions],
      { sourcePair: { source_commit: binding.app, carr_source_commit: binding.carr },
        runId: run.snapshot().id, fixtureRun: plan.run });
    if (missing.length) refusal('selected-journey-action-proof-incomplete');
    return { selected: journeys, completed: result.completed,
      observed_steps: result.steps.filter(row => row.state === 'observed').length,
      previously_observed_steps: result.steps.filter(row => row.state === 'previously-observed').length,
      action_proofs: journeys.reduce((total, id) => total + selectedActionRequirements[id].length, 0), full_v1_qualified: false };
  } catch (error) {
    const code = businessWorkerFailureCode(error);
    primaryError = code ? Object.assign(new Error(`Staging continuation refused: ${code}`), { code }) : error;
    throw primaryError;
  } finally {
    await cleanupPreservingPrimary(primaryError, async () => {
      let cleanupError;
      try { await factory.dispose(); } catch (error) { cleanupError = error; }
      try { removeStop(); await browser.close(); } catch (error) { cleanupError ||= error; }
      if (cleanupError) throw cleanupError;
    });
  }
}
