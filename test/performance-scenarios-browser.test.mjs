import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { WAIT_MS } from './browser-harness.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { chromium } from './browser-harness.mjs';
import { profile, screens } from '../scripts/performance-scenarios.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";

test('the phone Relationships performance scenario opens the visible connection detail', async t => {
  const outDir=await temporaryDirectory('doctorcre-perf-artifact-');
  t.after(()=>rm(outDir,{recursive:true,force:true}));
  await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir});
  const server = await startFixtureServer({env:{DOCTORCRE_FIXTURE_ROOT:join(outDir,'site')}});
  t.after(() => server.stop());
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: profile.viewport, isMobile: true, hasTouch: true });
  await page.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
  const scripts = new Map(), reads = [];
  page.on('response', response => {
    if (response.request().resourceType() === 'script') reads.push((async () => {
      assert.equal(response.ok(), true, response.url());
      scripts.set(response.url(), (await response.body()).length);
    })());
  });
  const screen = screens.find(screen => screen.id === 'relationships');
  await page.goto(server.url + screen.route, { waitUntil: 'networkidle' });
  await page.locator(screen.ready).first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator(screen.tap).first().tap();
  await page.waitForFunction(screen.complete);
  assert.match(await page.locator('.relationship-dialog').innerText(), /Demo Healthcare Lending/);
  assert.match(await page.locator('.relationship-dialog').innerText(), /Can introduce/);
  await Promise.all(reads);
  const budget = JSON.parse(await readFile(new URL('../contracts/performance-budget.v1.json', import.meta.url)));
  const bytes = [...scripts.values()].reduce((total, size) => total + size, 0);
  assert.ok(bytes <= budget.screens.relationships.jsBytes.limit,
    `Relationships loaded ${bytes} JS bytes, budget ${budget.screens.relationships.jsBytes.limit}`);
});

test('phone task guard exercises useful outcomes against the built fixture', async t => {
  const scenarios = await import('../scripts/performance-scenarios.mjs');
  const expected = ['task-agenda', 'task-leads', 'task-deal-link', 'task-deal-draft', 'task-tour-library', 'task-tour-offline'];
  assert.deepEqual(scenarios.tasks?.map(task => task.id), expected);
  const outDir = await temporaryDirectory('doctorcre-task-artifact-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(outDir, 'site') } });
  t.after(() => server.stop());
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  for (const task of scenarios.tasks) await t.test(task.id, async () => {
    const context = await browser.newContext({ viewport: profile.viewport, isMobile: true, hasTouch: true,
      serviceWorkers: task.id === 'task-tour-offline' ? 'allow' : 'block' });
    try {
      const page = await context.newPage();
      const cdp = ['task-tour-offline', 'task-leads'].includes(task.id) ? await scenarios.applyPhoneProfile(context, page) : undefined;
      const result = await scenarios.runTaskScenario({ page, context, origin: server.url, task, cdp }).catch(async error => {
        if (task.id === 'task-tour-offline') t.diagnostic(JSON.stringify(await page.evaluate(() => ({
          online: navigator.onLine, status: document.querySelector('#day-status')?.textContent,
          stops: document.querySelectorAll('.day-stop').length,
        }))));
        throw error;
      });
      assert.ok(result.lcpMs > 0, 'retain LCP alongside useful task readiness');
      assert.ok(result.usefulMs > 0);
      assert.ok(Number.isInteger(result.requestCount) && result.requestCount > 0);
      assert.ok(result.criticalBytes > 0);
      assert.equal(result.reads.length, result.requestCount);
      if (task.id === 'task-agenda') {
        assert.equal(result.reads.filter(name => name === 'getDeal').length, 0);
        assert.equal(result.reads.filter(name => name === 'getHomeAgenda').length, 1);
        assert.ok(result.reads.includes('notificationFeed'), 'count the shared shell reads as well as agenda reads');
        assert.ok(result.reads.includes('getLeadBoard'), 'count the lead board read assigned during home boot');
        assert.equal(result.reads.includes('listPracticeOrigination'), false, 'contact reasons wait for the secondary Home grid');
        assert.equal(result.reads.includes('readLeaseRadar'), false, 'past-client reads wait for the secondary Home grid');
      }
      if (task.id === 'task-leads') {
        assert.equal(result.reads.filter(name => name === 'lead-board').length, 4);
        const budget = JSON.parse(await readFile(new URL('../contracts/performance-budget.v1.json', import.meta.url)));
        assert.ok(result.criticalBytes <= budget.screens[task.id].criticalBytes.limit,
          `Lead task loaded ${result.criticalBytes} bytes, budget ${budget.screens[task.id].criticalBytes.limit}`);
      }
      if (task.id === 'task-tour-offline') assert.ok(result.resources.some(resource => resource.serviceWorker && resource.bytes > 0), 'include worker-owned shell preparation bytes');
      assert.deepEqual(result.errors, []);
    } finally { await context.close(); }
  });
});


test('built Review workflows keeps its data paint compact and preserves overdue deal navigation', async t => {
  const outDir = await temporaryDirectory('doctorcre-home-paint-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(outDir, 'site') } });
  t.after(() => server.stop());
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: profile.viewport, isMobile: true, hasTouch: true });
  await page.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
  const reads = [], errors = [], scriptUrls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.request().resourceType() === 'script') reads.push((async () => {
      scriptUrls.push(response.url());
      assert.equal(response.ok(), true, response.url());
      return (await response.body()).length;
    })());
  });
  const home = { route: '/review-workflows', ready: '#dealFlags .home-flag', tap: '[data-scope="mine"]', complete: () => document.querySelectorAll('#dealFlags .home-flag').length === 2 };
  await page.goto(server.url + home.route, { waitUntil: 'networkidle' });
  await page.locator(home.ready).first().waitFor();
  await page.locator(home.tap).tap();
  await page.waitForFunction(home.complete);
  const link = page.locator('#dealFlags h3 a').first();
  assert.match(await link.getAttribute('href'), /^\/deals\?deal=/);
  assert.ok((await link.innerText()).trim());
  const bytes = (await Promise.all(reads)).reduce((total, size) => total + size, 0);
  t.diagnostic(`Home transferred ${bytes} JavaScript bytes`);
  assert.ok(scriptUrls.every(url => !url.includes('terms-comparison')), 'Terms comparison loads only in the deal workspace');
  await page.locator('.home-grid').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Refresh past-client touches', exact: true }).waitFor();
  await page.locator('#homeIntroductions button:not([disabled])').first().waitFor();
  await page.locator('#homeContactReasons .work-card').first().waitFor();
  assert.deepEqual(errors, []);
});

test('Home discovers its boot mode while the client bootstrap is downloading', async t => {
  const outDir = await temporaryDirectory('doctorcre-home-boot-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(outDir, 'site') } });
  t.after(() => server.stop());
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: profile.viewport, isMobile: true, hasTouch: true });
  let release;
  const bootstrap = new Promise(resolve => { release = resolve; });
  await page.route(/\/js\/(?:home-boot|app-shell|workspace-command-center)\.js$/, async route => { await bootstrap; await route.continue(); });
  const mode = page.waitForRequest('**/js/boot-mode.js', { timeout: WAIT_MS });
  await page.goto(server.url + '/review-workflows', { waitUntil: 'commit' });
  try { await mode; } finally { release(); }
  await page.locator('#dealFlags .home-flag').first().waitFor();
  assert.ok(await page.locator('#dealFlags .home-flag').count() > 0);
});

test('Home timing covers root Home', () => { assert.equal(screens.find(screen => screen.id === 'home').route, '/'); });
test('Tours guidance keeps its phone width while the shared shell loads', async t => {
  const outDir = await temporaryDirectory('doctorcre-tour-paint-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(outDir, 'site') } });
  t.after(() => server.stop());
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  for (const width of [390, 820]) await t.test(`${width}px touch viewport`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
      let release;
      const shell = new Promise(resolve => { release = resolve; });
      await page.route('**/js/app-shell.js', async route => { await shell; await route.continue(); });
      await page.goto(server.url + '/tours', { waitUntil: 'commit' });
      const guidance = page.locator('.tour-library-page > p');
      await guidance.waitFor({ state: 'visible' });
      const before = await guidance.boundingBox();
      release();
      await page.locator('#appSidebarToggle').waitFor({ state: 'visible' });
      const after = await guidance.boundingBox();
      assert.equal(after.width, before.width, 'Shell mounting must not grow the guidance into a later LCP candidate');
      assert.equal(after.height, before.height, 'Guidance must retain its line wrapping');
    } finally { await context.close(); }
  });
});


test('Home performance expansion survives calendar, month and Chicago DST boundaries', async t => {
  const { applyPhoneProfile } = await import('../scripts/performance-scenarios.mjs');
  const outDir = await temporaryDirectory('doctorcre-home-clock-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(outDir, 'site') } });
  t.after(() => server.stop());
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  const home = screens.find(screen => screen.id === 'home');
  for (const now of ['2026-11-05T18:00:00Z', '2026-11-01T04:59:59Z', '2026-11-01T05:00:00Z',
    '2026-11-01T06:59:59Z', '2026-11-01T07:00:00Z', '2026-03-08T07:59:59Z', '2026-03-08T08:00:00Z']) {
    await t.test(now, async () => {
      const context = await browser.newContext({ viewport: profile.viewport, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date(now));
        await applyPhoneProfile(context, page);
        await page.goto(server.url + home.route, { waitUntil: 'networkidle' });
        await page.locator(home.ready).first().waitFor();
        const slice = page.locator('.home-slice[aria-label="Needs your attention"]');
        assert.equal(await slice.locator('[data-inbox-row]').count(), 1, 'collapsed attention slice retains its first task');
        await page.locator(home.tap).first().tap();
        await page.waitForFunction(home.complete);
        assert.equal(await slice.locator('[data-inbox-row]').count(), 2, 'timed expansion reveals both tasks');
        const elapsed = await page.evaluate(async () => {
          const started = performance.now();
          await new Promise(resolve => setTimeout(() => requestAnimationFrame(resolve), 25));
          return performance.now() - started;
        });
        assert.ok(elapsed >= 25, 'calendar pin preserves timers and the monotonic measurement clock');
      } finally { await context.close(); }
    });
  }
});
