import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { profile, screens, tasks, runTaskScenario, applyPhoneProfile } from './performance-scenarios.mjs';
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
      await applyPhoneProfile(context, page);
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
  for (const task of tasks) {
    const samples = [];
    for (let index = 0; index < profile.samples; index++) {
      const context = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: true, hasTouch: true, serviceWorkers: task.id === 'task-tour-offline' ? 'allow' : 'block' });
      const trace = `${task.id}-${index + 1}.zip`;
      await context.tracing.start({ screenshots: true, snapshots: true });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(30000);
        const cdp = await applyPhoneProfile(context, page);
        samples.push({ ...await runTaskScenario({ page, context, origin: url, task, cdp }), trace });
      } finally {
        await context.tracing.stop({ path: join(output, trace) });
        await context.close();
      }
    }
    measured[task.id] = {
      lcpMs: samples.map(sample => sample.lcpMs).sort((a, b) => a - b)[samples.length >> 1],
      usefulMs: samples.map(sample => sample.usefulMs).sort((a, b) => a - b)[samples.length >> 1],
      requestCount: Math.max(...samples.map(sample => sample.requestCount)),
      criticalBytes: Math.max(...samples.map(sample => sample.criticalBytes)), samples,
    };
    console.log(`${task.id}: LCP=${measured[task.id].lcpMs}ms useful=${measured[task.id].usefulMs}ms requests=${measured[task.id].requestCount} critical=${measured[task.id].criticalBytes}B`);
  }
  const report = { schema: 'doctorcre-performance-report.v1',
    taskMeasurement: {
      usefulMs: 'Navigation start through verified useful task outcome, including scripted actions. Offline measures the same-tab reload after online preparation.',
      requestCount: 'API, session, MCP and change-feed requests plus in-memory fixture public client calls through the useful outcome. Includes offline preparation. Maximum across cold samples.',
      criticalBytes: 'Successful same-origin decoded response body bytes through the useful outcome, including offline shell preparation. Not compressed wire bytes. Maximum across cold samples.',
      policy: 'Task scenarios block non-loopback resources and use synthetic adapters only. Each sample uses a cold context. Service workers are enabled only for saved-tour offline.',
      scenarios: Object.fromEntries(tasks.map(task => [task.id, task.conditions])),
    },
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
