import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stagingSession, STAGING_ORIGIN } from './session.mjs';
import { installStagingGuard } from './engine.mjs';
import { targets, screens } from './screens.mjs';
import { sweepScreen } from './controls.mjs';
import { writeReport, newDeadControls } from './report.mjs';
import { prepareStagingRecords } from './records.mjs';

export const outputPath = () => resolve(process.env.E2E_V2_OUTPUT || '/Users/booko/carr-system/out/orch/e2e-v2');
export function scrubEvidence(path) {
  const result = spawnSync('python3', [fileURLToPath(new URL('./scrub-evidence.py', import.meta.url)), path], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error('Evidence scrub failed; private artifacts were not published');
}

export async function sweep() {
  process.env.E2E_TELEMETRY_DISABLED = '1';
  const output = outputPath();
  const setup = await prepareStagingRecords(output);
  const { release } = setup;
  const routedScreens = await screens();
  const expectedScreens = targets.reduce((count, target) => count + routedScreens.filter(screen => screen.surface === target.surface).length, 0);
  const evidenceDir = join(output, 'evidence', 'sweep');
  const privateEvidence = fileURLToPath(new URL('../../.e2e/staging-private-evidence/', import.meta.url));
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch();
  const measured = [];
  let evidenceNumber = 0;
  try {
    for (const target of targets) for (const screen of routedScreens.filter(screen => screen.surface === target.surface)) {
      console.log(`Sweeping ${target.name} ${screen.path}`);
      const freshPage = async () => {
        const { state, release: currentRelease } = await stagingSession();
        if (currentRelease.source_commit !== release.source_commit || currentRelease.carr_source_commit !== release.carr_source_commit) throw new Error('Staging source changed during the control sweep');
        const context = await browser.newContext({ viewport: target.viewport, storageState: state, serviceWorkers: 'block' });
        await installStagingGuard(context);
        const page = await context.newPage();
        try {
          const response = await page.goto(new URL(screen.path, STAGING_ORIGIN).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          if (!response?.ok() || page.url().includes('/auth/') || new URL(page.url()).origin !== STAGING_ORIGIN) throw new Error('Screen did not load signed in on staging');
          await page.waitForLoadState('networkidle', { timeout: 30_000 });
          await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
          return page;
        } catch { await context.close(); throw new Error('Screen did not load signed in on staging'); }
      };
      let result;
      try {
        result = await sweepScreen({ freshPage, screen, target: target.name, routedPaths: routedScreens.map(screen => screen.path), evidence: async (page, row) => {
          const filename = `${String(++evidenceNumber).padStart(5, '0')}-${row.status}`;
          const raw = join(privateEvidence, filename);
          await mkdir(raw, { recursive: true, mode: 0o700 });
          const png = join(raw, `${filename}.png`);
          await page.screenshot({ path: png, fullPage: true });
          await page.context().tracing.stop({ path: join(raw, `${filename}.zip`) });
          scrubEvidence(raw);
          await cp(raw, evidenceDir, { recursive: true });
          return join(evidenceDir, `${filename}.png`);
        } });
      } catch { result = { ...screen, target: target.name, reached: false, controls: [], error: 'Signed-in screen failed to load' }; }
      measured.push(result);

      await writeReport(output, { screens: measured, release, setup, expectedScreens, findings: setup.findings });
      scrubEvidence(output);
      console.log(`${result.controls.length} enumerated; ${result.controls.filter(row => row.status === 'DEAD').length} DEAD`);
    }
  } finally { await browser.close(); }
  const allowlist = JSON.parse(await readFile(new URL('./dead-allowlist.json', import.meta.url), 'utf8'));
  const controls = measured.flatMap(screen => screen.controls);
  const dead = newDeadControls(controls, allowlist);
  const incomplete = measured.some(screen => !screen.reached || screen.exhausted || screen.controls.some(row => ['ERROR','UNREACHABLE'].includes(row.status) || row.status === 'DISABLED' && row.reason === 'No reason provided'));
  await writeFile(join(output, 'sweep-verdict.json'), JSON.stringify({ completed: !incomplete, newDeadControls: dead.map(row => row.key), measuredAt: new Date().toISOString(), release }, null, 2) + '\n');
  if (dead.length || incomplete) throw new Error(`Staging sweep failed: ${dead.length} new DEAD controls; completeness ${incomplete ? 'FAILED' : 'passed'}. See coverage.md.`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) sweep().catch(error => { console.error(error.message); process.exitCode = 1; });
