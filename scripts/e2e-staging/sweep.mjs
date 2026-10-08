import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagingSession, STAGING_ORIGIN, SessionPreflightFailure } from './session.mjs';
import { installStagingGuard } from './engine.mjs';
import { targets, screens } from './screens.mjs';
import { sweepScreen, SweepFailure } from './controls.mjs';
import { writeReport } from './report.mjs';
import { scrubEvidence } from './evidence.mjs';
export { scrubEvidence } from './evidence.mjs';
import { prepareStagingRecords } from './records.mjs';
import { sweepOwnerStates } from './owner-states.mjs';
import { prepareCalendarRecord } from './calendar-coverage.mjs';
import { createRecordedActionContinuation } from './recorded-action-reconciliation.mjs';
import { createSweepRun, readSweepCheckpoint, sweepOptions } from './resume.mjs';
import { assertProfilePermits } from './run-budget.mjs';

export const outputPath = () => resolve(process.env.E2E_V2_OUTPUT || '/Users/booko/carr-system/out/orch/e2e-v2');
export async function persistSweepReport(output, run, setup, { publishFile } = {}) {
  await writeReport(output, { ...run.snapshot(), release: setup.release, setup, findings: setup.findings, publishFile });
}

export async function sweep({ resume = false, recordedActionProof, prepareRecords = prepareStagingRecords } = {}) {
  // The full sweep creates staging fixtures and presses destructive controls.
  // No approved run budget funds either, so it refuses before any setup.
  assertProfilePermits('fixture');
  assertProfilePermits('mutation');
  if (typeof resume !== 'boolean') throw new Error('Staging sweep resume must be a boolean');
  process.env.E2E_TELEMETRY_DISABLED = '1';
  const output = outputPath();
  const routedScreens = await screens();
  let prior = resume ? await readSweepCheckpoint(output) : undefined;
  if (resume && !prior) throw new Error('Resume requires an existing staging sweep checkpoint');
  if (recordedActionProof && !resume) throw new Error('Recorded action recovery requires resume');
  const continuation = recordedActionProof ? await createRecordedActionContinuation({ prior, proof: recordedActionProof }) : null;
  if (continuation) prior = continuation.prior;
  const run = createSweepRun({ targets, routedScreens, prior });
  const setup = await prepareRecords(output, { reuseOnly: resume, session: async origin => {
    const current = await stagingSession(origin);
    run.assertRelease(current.release);
    return current;
  } });
  const { release } = setup;
  const privateEvidence = fileURLToPath(new URL('../../.e2e/staging-private-evidence/', import.meta.url));
  const browser = run.pending.length || run.pendingStates().length ? await chromium.launch() : null;
  const freshPageFor = (target, screen, spec) => async (request = {}) => {
    let context, phase = 'session-preflight', code = 'session-preflight-failed';
    try {
      const { state, release: currentRelease } = await stagingSession();
      if (currentRelease.source_commit !== release.source_commit || currentRelease.carr_source_commit !== release.carr_source_commit) throw new SweepFailure('session-preflight', 'source-pair-changed');
      phase = 'context'; code = 'context-creation-failed';
      context = await browser.newContext({ viewport: target.viewport, storageState: state, serviceWorkers: 'block' });
      code = 'guard-install-failed';
      await installStagingGuard(context);
      code = 'page-creation-failed';
      const page = await context.newPage();
      phase = 'navigation'; code = 'navigation-failed';
      const response = await page.goto(new URL(request.path || spec?.url || screen.path, STAGING_ORIGIN).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (!response?.ok() || page.url().includes('/auth/') || new URL(page.url()).origin !== STAGING_ORIGIN) throw new SweepFailure('navigation', 'screen-response-refused');
      phase = 'load'; code = 'network-idle-failed';
      await page.waitForLoadState('networkidle', { timeout: 30_000 });
      phase = 'tracing'; code = 'tracing-start-failed';
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      if (spec?.kind === 'calendar-record') await prepareCalendarRecord(page, spec);
      return page;
    } catch (error) {
      if (context) await context.close().catch(() => {});
      throw error instanceof SweepFailure ? error : new SweepFailure(phase, error instanceof SessionPreflightFailure ? error.code : code);
    }
  };
  const evidence = async (page, row) => {
    const paths = run.evidencePaths(output, privateEvidence, row.status === 'passed' ? 'OBSERVED' : row.status === 'failed' ? 'ERROR' : row.status);
    await mkdir(paths.privateDir, { recursive: true, mode: 0o700 });
    await page.screenshot({ path: paths.png, fullPage: true });
    await page.context().tracing.stop({ path: paths.trace });
    scrubEvidence(paths.privateDir);
    await mkdir(paths.publicDir, { recursive: true, mode: 0o700 });
    await cp(paths.privateDir, paths.publicDir, { recursive: true });
    return paths.publishedPNG;
  };
  try {
    for (const { target, screen } of run.pending) {
      console.log('Sweeping ' + target.name + ' ' + screen.path);
      const freshPage = freshPageFor(target, screen);
      let result;
      try {
        result = await sweepScreen({ freshPage, screen, target: target.name, prior: run.priorScreen(target.name, screen.path), routedPaths: routedScreens.map(screen => screen.path), recordedActionRuntime: target.name === 'staging-live' && screen.path === '/' ? continuation?.runtime : undefined, checkpoint: async partial => {
          run.record(partial);
          await persistSweepReport(output, run, setup);
        }, evidence });
      } catch { result = { ...(run.snapshot().screens.find(row => row.target === target.name && row.path === screen.path) || { ...screen, target: target.name, reached: false, controls: [] }), failure: { phase: 'sweep', code: 'unexpected-sweep-failure', openers: [] } }; }
      run.record(result);

      await persistSweepReport(output, run, setup);
      console.log(`${result.controls.length} enumerated; ${result.controls.filter(row => row.status === 'DEAD').length} DEAD`);
      if (result.failure) console.log(`Sweep stopped: ${result.failure.phase}/${result.failure.code}`);
    }
    await sweepOwnerStates({ run, targets, routedScreens, freshPageFor, evidence,
      persist: () => persistSweepReport(output, run, setup) });
  } finally { if (browser) await browser.close(); }
  if (!run.pending.length) {
    await persistSweepReport(output, run, setup);
  }
  const allowlist = JSON.parse(await readFile(new URL('./dead-allowlist.json', import.meta.url), 'utf8'));
  const verdict = run.verdict(allowlist);
  await writeFile(join(output, 'sweep-verdict.json'), JSON.stringify({ ...verdict, measuredAt: new Date().toISOString(), release }, null, 2) + '\n');
  if (verdict.newDeadControls.length || !verdict.completed) throw new Error(`Staging sweep failed: ${verdict.newDeadControls.length} new DEAD controls; completeness ${verdict.completed ? 'passed' : 'FAILED'}. See coverage.md.`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) Promise.resolve().then(() => sweep(sweepOptions(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1; });
