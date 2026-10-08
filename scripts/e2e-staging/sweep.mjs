// The staging control sweep, funded only by an authorized sweep-explore run.
// Host headroom is checked before the authorization opens. One preflight
// starts the run; each fresh page re-checks the deployed source with one
// charged request, takes a charged browser context and routes every request
// through the budget, where a write is admitted only for this run's synthetic
// fixture records. Screenshots and their published copies are charged; there
// is no trace or video.
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStagingRelease, stagingSession, STAGING_ORIGIN, SessionPreflightFailure } from './session.mjs';
import { installBudgetedRoute } from './budgeted-route.mjs';
import { targets, screens } from './screens.mjs';
import { sweepScreen, SweepFailure } from './controls.mjs';
import { writeReport } from './report.mjs';
export { scrubEvidence } from './evidence.mjs';
import { prepareStagingRecords } from './records.mjs';
import { sweepOwnerStates } from './owner-states.mjs';
import { prepareCalendarRecord } from './calendar-coverage.mjs';
import { createRecordedActionContinuation } from './recorded-action-reconciliation.mjs';
import { createSweepRun, readSweepCheckpoint, sweepOptions } from './resume.mjs';
import { BUDGET_DIR, BudgetRefusal, SWEEP_EXPLORE } from './run-budget.mjs';
import { HOST_PROBE, openWithHeadroom } from './host-headroom.mjs';

export const outputPath = () => resolve(process.env.E2E_V2_OUTPUT || '/Users/booko/carr-system/out/orch/e2e-v2');
export async function persistSweepReport(output, run, setup, { publishFile } = {}) {
  await writeReport(output, { ...run.snapshot(), release: setup.release, setup, findings: setup.findings, publishFile });
}

export async function sweep({
  resume = false, recordedActionProof, prepareRecords = prepareStagingRecords, budgetDir = BUDGET_DIR, host = HOST_PROBE,
  output = outputPath(), launch = () => chromium.launch(), clock,
} = {}) {
  if (typeof resume !== 'boolean') throw new Error('Staging sweep resume must be a boolean');
  const budget = await openWithHeadroom({ dir: budgetDir, profile: SWEEP_EXPLORE.name, host, clock });
  let verdict = null, failure = null, browser = null;
  try {
    process.env.E2E_TELEMETRY_DISABLED = '1';
    const routedScreens = await screens();
    let prior = resume ? await readSweepCheckpoint(output) : undefined;
    if (resume && !prior) throw new Error('Resume requires an existing staging sweep checkpoint');
    if (recordedActionProof && !resume) throw new Error('Recorded action recovery requires resume');
    const continuation = recordedActionProof ? await createRecordedActionContinuation({ prior, proof: recordedActionProof }) : null;
    if (continuation) prior = continuation.prior;
    const run = createSweepRun({ targets, routedScreens, prior });
    // One preflight for the whole run; the cap of eight preflight requests
    // does not allow one per screen.
    let preflighted = null;
    const session = async origin => {
      preflighted ??= await stagingSession(origin, { budget });
      run.assertRelease(preflighted.release);
      return preflighted;
    };
    const setup = await prepareRecords(output, { reuseOnly: resume, budget, session });
    const { release } = setup;
    const { state } = await session(STAGING_ORIGIN);
    const startedTargets = new Set();
    const charged = new Map();
    const startTarget = async target => {
      if (startedTargets.has(target.name)) return;
      startedTargets.add(target.name);
      await budget.reserve('target');
      await budget.reserve('viewport');
    };
    browser = run.pending.length || run.pendingStates().length ? await launch() : null;
    const freshPageFor = (target, screen, spec) => async (request = {}) => {
      let context, phase = 'release-check', code = 'release-check-failed';
      try {
        await startTarget(target);
        const current = await checkStagingRelease(budget);
        if (current.source_commit !== release.source_commit || current.carr_source_commit !== release.carr_source_commit) throw new SweepFailure('session-preflight', 'source-pair-changed');
        phase = 'context'; code = 'context-creation-failed';
        await budget.reserve('context');
        context = await browser.newContext({ viewport: target.viewport, storageState: state, serviceWorkers: 'block' });
        code = 'guard-install-failed';
        await installBudgetedRoute(context, budget);
        code = 'page-creation-failed';
        const page = await context.newPage();
        phase = 'navigation'; code = 'navigation-failed';
        const response = await page.goto(new URL(request.path || spec?.url || screen.path, STAGING_ORIGIN).href, { waitUntil: 'domcontentloaded', timeout: budget.timeoutMs() });
        if (!response?.ok() || page.url().includes('/auth/') || new URL(page.url()).origin !== STAGING_ORIGIN) throw new SweepFailure('navigation', 'screen-response-refused');
        phase = 'load'; code = 'network-idle-failed';
        await page.waitForLoadState('networkidle', { timeout: budget.timeoutMs() });
        if (spec?.kind === 'calendar-record') await prepareCalendarRecord(page, spec);
        return page;
      } catch (error) {
        if (context) await context.close().catch(() => {});
        if (error instanceof BudgetRefusal) throw error;
        throw error instanceof SweepFailure ? error : new SweepFailure(phase, error instanceof SessionPreflightFailure ? error.code : code);
      }
    };
    const evidence = async (page, row) => {
      const paths = run.evidencePaths(output, budget.evidenceDir, row.status === 'passed' ? 'OBSERVED' : row.status === 'failed' ? 'ERROR' : row.status);
      const name = `${basename(dirname(paths.privateDir))}-${basename(paths.png)}`;
      await budget.captureScreenshot(page, name, { type: 'png', fullPage: true });
      await mkdir(paths.publicDir, { recursive: true, mode: 0o700 });
      await budget.exportEvidence(name, paths.publishedPNG);
      return paths.publishedPNG;
    };
    // Controls are charged as the sweep reports them.
    const chargeControls = async (key, partial) => {
      const count = partial?.controls?.length || 0;
      const delta = count - (charged.get(key) || 0);
      if (delta > 0) { await budget.reserve('control', delta); charged.set(key, count); }
    };
    for (const { target, screen } of run.pending) {
      if (budget.stopped) break;
      console.log('Sweeping ' + target.name + ' ' + screen.path);
      const key = target.name + ' ' + screen.path;
      const freshPage = freshPageFor(target, screen);
      let result;
      try {
        result = await sweepScreen({ freshPage, screen, target: target.name, prior: run.priorScreen(target.name, screen.path), routedPaths: routedScreens.map(row => row.path), recordedActionRuntime: target.name === 'staging-live' && screen.path === '/' ? continuation?.runtime : undefined, checkpoint: async partial => {
          await chargeControls(key, partial);
          run.record(partial);
          await persistSweepReport(output, run, setup);
        }, evidence });
      } catch { result = { ...(run.snapshot().screens.find(row => row.target === target.name && row.path === screen.path) || { ...screen, target: target.name, reached: false, controls: [] }), failure: { phase: 'sweep', code: 'unexpected-sweep-failure', openers: [] } }; }
      await chargeControls(key, result).catch(() => {});
      run.record(result);
      await persistSweepReport(output, run, setup);
      console.log(`${result.controls.length} enumerated; ${result.controls.filter(row => row.status === 'DEAD').length} DEAD`);
      if (result.failure) console.log(`Sweep stopped: ${result.failure.phase}/${result.failure.code}`);
    }
    if (!budget.stopped) await sweepOwnerStates({ run, targets, routedScreens, freshPageFor, evidence,
      admit: () => budget.reserve('ownerState'), persist: () => persistSweepReport(output, run, setup) });
    if (!run.pending.length) await persistSweepReport(output, run, setup);
    const allowlist = JSON.parse(await readFile(new URL('./dead-allowlist.json', import.meta.url), 'utf8'));
    verdict = run.verdict(allowlist);
    await writeFile(join(output, 'sweep-verdict.json'), JSON.stringify({ ...verdict, measuredAt: new Date().toISOString(), release }, null, 2) + '\n');
  } catch (error) {
    failure = error instanceof BudgetRefusal ? { phase: 'budget', code: error.code } : { phase: 'sweep', code: 'unexpected-failure' };
    await budget.stop(failure.code).catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  const receipt = await budget.finish({ schema: 'sweep-explore-receipt.v1', kind: 'sweep', failure,
    qualified: Boolean(verdict?.completed && !verdict.newDeadControls.length && !failure),
    new_dead_controls: verdict?.newDeadControls.length ?? null });
  if (failure) throw new BudgetRefusal(failure.code);
  if (verdict.newDeadControls.length || !verdict.completed || receipt.stopped.reason !== 'completed')
    throw new Error(`Staging sweep failed: ${verdict.newDeadControls.length} new DEAD controls; completeness ${verdict.completed ? 'passed' : 'FAILED'}; run stopped as ${receipt.stopped.reason}. See coverage.md.`);
  return receipt;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) Promise.resolve().then(() => sweep(sweepOptions(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1; });
