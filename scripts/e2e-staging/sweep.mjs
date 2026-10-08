import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { targets, screens } from './screens.mjs';
import { sweepScreen } from './controls.mjs';
import { writeReport } from './report.mjs';
import { scrubEvidence } from './evidence.mjs';
export { scrubEvidence } from './evidence.mjs';
import { prepareStagingRecords } from './records.mjs';
import { createSweepRun, readSweepCheckpoint } from './resume.mjs';

export const outputPath = () => resolve(process.env.E2E_V2_OUTPUT || '/Users/booko/carr-system/out/orch/e2e-v2');
export async function persistSweepReport(output, run, setup) {
  await writeReport(output, { ...run.snapshot(), release: setup.release, setup, findings: setup.findings });
}

export async function sweep({ resume = false, targetName, freshPage, session } = {}) {
  if (typeof resume !== 'boolean') throw new Error('Staging sweep resume must be a boolean');
  const targetIndex = targets.findIndex(target => target.name === targetName);
  if (targetIndex < 0 || typeof freshPage !== 'function' || typeof session !== 'function') throw new Error('Staging sweep requires a Playwright target, fresh-page fixture and session fixture');
  process.env.E2E_TELEMETRY_DISABLED = '1';
  const output = outputPath();
  const routedScreens = await screens();
  const checkpoint = await readSweepCheckpoint(output);
  const prior = resume || targetIndex > 0 ? checkpoint : undefined;
  if ((resume || targetIndex > 0) && !prior) throw new Error('Resume requires an existing staging sweep checkpoint');
  const run = createSweepRun({ targets, routedScreens, prior });
  const setup = await prepareStagingRecords(output, { reuseOnly: resume || targetIndex > 0, session: async origin => {
    const current = await session(origin);
    run.assertRelease(current.release);
    return current;
  } });
  const { release } = setup;
  const privateEvidence = fileURLToPath(new URL('../../.e2e/staging-private-evidence/', import.meta.url));
  for (const { target, screen } of run.pending.filter(entry => entry.target.name === targetName)) {
      console.log(`Sweeping ${target.name} ${screen.path}`);
      let result;
      try {
        result = await sweepScreen({ freshPage: () => freshPage({ screen, release }), screen, target: target.name, routedPaths: routedScreens.map(screen => screen.path), checkpoint: async partial => {
          run.record(partial);
          await persistSweepReport(output, run, setup);
        }, evidence: async (page, row) => {
          const paths = run.evidencePaths(output, privateEvidence, row.status);
          await mkdir(paths.privateDir, { recursive: true, mode: 0o700 });
          await page.screenshot({ path: paths.png, fullPage: true });
          scrubEvidence(paths.privateDir);
          await mkdir(paths.publicDir, { recursive: true, mode: 0o700 });
          await cp(paths.privateDir, paths.publicDir, { recursive: true });
          return paths.publishedPNG;
        } });
      } catch { result = { ...(run.snapshot().screens.find(row => row.target === target.name && row.path === screen.path) || { ...screen, target: target.name, reached: false, controls: [] }), failure: { phase: 'sweep', code: 'unexpected-sweep-failure', openers: [] } }; }
      run.record(result);

      await persistSweepReport(output, run, setup);
      console.log(`${result.controls.length} enumerated; ${result.controls.filter(row => row.status === 'DEAD').length} DEAD`);
      if (result.failure) console.log(`Sweep stopped: ${result.failure.phase}/${result.failure.code}`);
  }
  await persistSweepReport(output, run, setup);
  if (targetIndex !== targets.length - 1) return;
  const allowlist = JSON.parse(await readFile(new URL('./dead-allowlist.json', import.meta.url), 'utf8'));
  const verdict = run.verdict(allowlist);
  await writeFile(join(output, 'sweep-verdict.json'), JSON.stringify({ ...verdict, measuredAt: new Date().toISOString(), release }, null, 2) + '\n');
  if (verdict.newDeadControls.length || !verdict.completed) throw new Error(`Staging sweep failed: ${verdict.newDeadControls.length} new DEAD controls; completeness ${verdict.completed ? 'passed' : 'FAILED'}. See coverage.md.`);
}
