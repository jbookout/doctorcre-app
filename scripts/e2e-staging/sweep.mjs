import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagingWriteRefusals } from './engine.mjs';
import { targets, screens } from './screens.mjs';
import { sweepScreen, SweepFailure } from './controls.mjs';
import { writeReport } from './report.mjs';
import { scrubEvidence } from './evidence.mjs';
export { scrubEvidence } from './evidence.mjs';
import { prepareStagingRecords, stagingFixtureWriteGuard } from './records.mjs';
import { sweepOwnerStates } from './owner-states.mjs';
import { createRecordedActionContinuation } from './recorded-action-reconciliation.mjs';
import { createSweepRun, readSweepCheckpoint } from './resume.mjs';

export const outputPath = () => resolve(process.env.E2E_V2_OUTPUT || '/Users/booko/carr-system/out/orch/e2e-v2');
export async function persistSweepReport(output, run, setup, { publishFile } = {}) {
  await writeReport(output, { ...run.snapshot(), release: setup.release, setup, findings: setup.findings, publishFile });
}

export async function sweep({ resume = false, targetName, freshPage, session, recordedActionProof } = {}) {
  if (typeof resume !== 'boolean') throw new Error('Staging sweep resume must be a boolean');
  const targetIndex = targets.findIndex(target => target.name === targetName);
  if (targetIndex < 0 || typeof freshPage !== 'function' || typeof session !== 'function') throw new Error('Staging sweep requires a Playwright target, fresh-page fixture and session fixture');
  process.env.E2E_TELEMETRY_DISABLED = '1';
  const output = outputPath();
  const routedScreens = await screens();
  const checkpoint = await readSweepCheckpoint(output);
  let prior = resume || targetIndex > 0 ? checkpoint : undefined;
  if ((resume || targetIndex > 0) && !prior) throw new Error('Resume requires an existing staging sweep checkpoint');
  if (recordedActionProof && !resume) throw new Error('Recorded action recovery requires resume');
  const continuation = recordedActionProof ? await createRecordedActionContinuation({ prior, proof: recordedActionProof }) : null;
  if (continuation) prior = continuation.prior;
  const run = createSweepRun({ targets, routedScreens, prior });
  const setup = await prepareStagingRecords(output, { reuseOnly: resume || targetIndex > 0, session: async origin => {
    const current = await session(origin);
    run.assertRelease(current.release);
    return current;
  } });
  const { release } = setup;
  const fixtureGuard = stagingFixtureWriteGuard({ output, release });
  const privateEvidence = fileURLToPath(new URL('../../.e2e/staging-private-evidence/', import.meta.url));
  const freshPageFor = (target, screen, spec) => async (request = {}) =>
    freshPage({ screen, release, fixtureGuard, path: request.path || spec?.url || screen.path, spec });
  const evidence = async (page, row) => {
    try {
      await fixtureGuard.assertCoverage();
      if (stagingWriteRefusals(page.context()).length) throw new Error('Fixture scope incomplete');
    } catch {
      row.status = 'ERROR'; row.reason = 'Test fixture write policy refused or unsettled; coverage remains incomplete';
      throw new SweepFailure('fixture-scope', 'write-scope-unproved');
    }
    const paths = run.evidencePaths(output, privateEvidence, row.status === 'passed' ? 'OBSERVED' : row.status === 'failed' ? 'ERROR' : row.status);
    await mkdir(paths.privateDir, { recursive: true, mode: 0o700 });
    await page.screenshot({ path: paths.png, fullPage: true });
    scrubEvidence(paths.privateDir);
    await mkdir(paths.publicDir, { recursive: true, mode: 0o700 });
    await cp(paths.privateDir, paths.publicDir, { recursive: true });
    return paths.publishedPNG;
  };
  for (const { target, screen } of run.pending.filter(entry => entry.target.name === targetName)) {
    console.log('Sweeping ' + target.name + ' ' + screen.path);
    const measuredPage = freshPageFor(target, screen);
    let result;
    try {
      result = await sweepScreen({ freshPage: measuredPage, screen, target: target.name, prior: run.priorScreen(target.name, screen.path), routedPaths: routedScreens.map(screen => screen.path), recordedActionRuntime: target.name === 'staging-live' && screen.path === '/' ? continuation?.runtime : undefined, checkpoint: async partial => {
        run.record(partial);
        await persistSweepReport(output, run, setup);
      }, evidence });
    } catch { result = { ...(run.snapshot().screens.find(row => row.target === target.name && row.path === screen.path) || { ...screen, target: target.name, reached: false, controls: [] }), failure: { phase: 'sweep', code: 'unexpected-sweep-failure', openers: [] } }; }
    run.record(result);

    await persistSweepReport(output, run, setup);
    console.log(`${result.controls.length} enumerated; ${result.controls.filter(row => row.status === 'DEAD').length} DEAD`);
    if (result.failure) console.log(`Sweep stopped: ${result.failure.phase}/${result.failure.code}`);
  }
  await sweepOwnerStates({ run, targets, targetName, routedScreens, freshPageFor, evidence,
    persist: () => persistSweepReport(output, run, setup) });
  await persistSweepReport(output, run, setup);
  if (targetIndex !== targets.length - 1) {
    await fixtureGuard.assertCoverage();
    return;
  }
  const allowlist = JSON.parse(await readFile(new URL('./dead-allowlist.json', import.meta.url), 'utf8'));
  const verdict = run.verdict(allowlist);
  try { await fixtureGuard.assertCoverage(); verdict.fixtureWriteScopeComplete = true; }
  catch { verdict.fixtureWriteScopeComplete = false; verdict.completed = false; }
  await writeFile(join(output, 'sweep-verdict.json'), JSON.stringify({ ...verdict, measuredAt: new Date().toISOString(), release }, null, 2) + '\n');
  if (verdict.newDeadControls.length || !verdict.completed) throw new Error(`Staging sweep failed: ${verdict.newDeadControls.length} new DEAD controls; completeness ${verdict.completed ? 'passed' : 'FAILED'}. See coverage.md.`);
}
