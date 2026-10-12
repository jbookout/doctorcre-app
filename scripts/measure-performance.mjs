import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { profile, screens } from './performance-scenarios.mjs';
import { startFixtureServer } from './fixture-server.mjs';
import { directoryFixture } from '../test/fixtures/vendor-directory.synthetic.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'test-artifacts/performance');
await mkdir(output, { recursive: true });
const manifestBytes = await readFile(join(root, 'dist/doctorcre-app.manifest.json'));
const manifest = JSON.parse(manifestBytes);
const archive = await readFile(join(root, 'dist/doctorcre-app.tar'));
const digest = createHash('sha256').update(archive).digest('hex');
if ((await readFile(join(root, 'dist/doctorcre-app.tar.sha256'), 'utf8')).trim() !== `${digest}  doctorcre-app.tar`) throw Error('build digest mismatch');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (manifest.source_commit !== sourceCommit) throw Error('build source differs from checkout');
const scriptFiles = manifest.files.filter(file => /\.(m?js)$/.test(file.path));
const bundleFiles = await Promise.all(scriptFiles.map(async file => {
  const bytes = await readFile(join(root, 'dist/site', file.path));
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error(`build file mismatch: ${file.path}`);
  return { path: file.path, jsBytes: bytes.length, gzipBytes: gzipSync(bytes).length };
}));
const bundle = { jsBytes: bundleFiles.reduce((n, file) => n + file.jsBytes, 0),
  gzipBytes: bundleFiles.reduce((n, file) => n + file.gzipBytes, 0), files: bundleFiles };
let server, browser;
try {
  server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(root, 'dist/site') } });
  const { url } = server;
  browser = await chromium.launch();
  const measured = {};
  for (const screen of screens) {
    const samples = [];
    for (let index = 0; index < profile.samples; index++) {
      const context = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      const trace = `${screen.id}-${index + 1}.zip`;
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      // Reuse the directory journey's populated fixture; no CARR endpoint is used.
      if (screen.id === 'vendors') await page.route('**/api/v1/business/**', route =>
        route.fulfill({ json: directoryFixture(route.request().url()) }));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown });
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latencyMs,
        downloadThroughput: profile.downloadBytesPerSecond, uploadThroughput: profile.uploadBytesPerSecond });
      const js = new Map();
      const reads = [];
      const failures = [];
      page.on('response', response => {
        if (response.request().resourceType() !== 'script') return;
        reads.push((async () => {
          if (!response.ok()) throw Error(`script failed: ${response.url()}`);
          js.set(response.url(), (await response.body()).length);
        })());
      });
      page.on('pageerror', error => failures.push(error.message));
      await page.addInitScript(() => {
        window.__perfLcp = null;
        new PerformanceObserver(list => {
          window.__perfLcp = list.getEntries().at(-1).startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      try {
        await page.goto(url + screen.route, { waitUntil: 'networkidle' });
        await page.locator(screen.ready).first().waitFor({ state: 'visible' });
        await page.waitForFunction(() => window.__perfLcp > 0);
        const lcpMs = await page.evaluate(() => window.__perfLcp);
        const complete = screen.complete.toString();
        await page.evaluate(complete => {
          const isComplete = (0, eval)(`(${complete})`);
          window.__perfInteraction = null;
          document.addEventListener('pointerdown', event => {
            const start = event.timeStamp;
            const check = () => {
              if (isComplete()) requestAnimationFrame(() => requestAnimationFrame(() => {
                window.__perfInteraction = performance.now() - start;
              }));
              else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          }, { once: true, capture: true });
        }, complete);
        await page.locator(screen.tap).first().tap();
        await page.waitForFunction(() => window.__perfInteraction > 0);
        const interactionMs = await page.evaluate(() => window.__perfInteraction);
        await Promise.all(reads);
        if (failures.length) throw Error(`screen errors: ${failures.join('; ')}`);
        const jsBytes = [...js.values()].reduce((n, bytes) => n + bytes, 0);
        if (![lcpMs, interactionMs, jsBytes].every(n => Number.isFinite(n) && n > 0)) throw Error('missing performance measurement');
        samples.push({ lcpMs: Math.round(lcpMs), interactionMs: Math.ceil(interactionMs), jsBytes, trace,
          scripts: [...js.keys()].map(value => new URL(value).pathname).sort() });
      } finally {
        await context.tracing.stop({ path: join(output, trace) });
        await context.close();
      }
    }
    const median = key => samples.map(sample => sample[key]).sort((a, b) => a - b)[samples.length >> 1];
    measured[screen.id] = { lcpMs: median('lcpMs'), jsBytes: Math.max(...samples.map(sample => sample.jsBytes)), interactionMs: median('interactionMs'), samples };
    console.log(`${screen.id}: LCP=${measured[screen.id].lcpMs}ms JS=${measured[screen.id].jsBytes}B interaction=${measured[screen.id].interactionMs}ms`);
  }
  const report = { schema: 'doctorcre-performance-report.v1',
    measuredAt: new Date().toISOString(), sourceCommit, prHeadCommit: process.env.PERFORMANCE_PR_HEAD_SHA || sourceCommit,
    buildDigest: digest, browserVersion: browser.version(),
    nodeVersion: process.version, platform: process.platform, profile, screens: measured, bundle };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  // One complete line in the job log, so a hosted run can be rebaselined with
  // `performance-budget.mjs --rebaseline` after its artifact has expired.
  // Base64url: Actions masking rewrites braces when a multi-line secret is set.
  console.log(`performance-report ${Buffer.from(JSON.stringify({ ...report,
    screens: Object.fromEntries(Object.entries(measured).map(([id, { samples, ...metrics }]) => [id, metrics])),
    bundle: { jsBytes: bundle.jsBytes, gzipBytes: bundle.gzipBytes } })).toString('base64url')}`);
} finally {
  await browser?.close();
  await server?.stop();
}
