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
import { startFixtureServer } from '../scripts/fixture-server.mjs';

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
  const expected = ['task-react-home', 'task-agenda', 'task-leads', 'task-deal-link', 'task-deal-draft', 'task-tour-library', 'task-tour-offline'];
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
      const cdp = task.id === 'task-tour-offline' ? await scenarios.applyPhoneProfile(context, page) : undefined;
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
      if (task.fixture === 'inbox') assert.equal(result.reads.filter(name => name === 'read-home-inbox').length, 1);
      if (task.id === 'task-leads') assert.equal(result.reads.filter(name => name === 'lead-board').length, 4);
      if (task.id === 'task-tour-offline') assert.ok(result.resources.some(resource => resource.serviceWorker && resource.bytes > 0), 'include worker-owned shell preparation bytes');
      assert.deepEqual(result.errors, []);
    } finally { await context.close(); }
  });
});


test('built Home keeps its data paint compact and preserves overdue deal navigation', async t => {
  const outDir = await temporaryDirectory('doctorcre-home-paint-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(outDir, 'site') } });
  t.after(() => server.stop());
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: profile.viewport, isMobile: true, hasTouch: true });
  await page.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
  const reads = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.request().resourceType() === 'script') reads.push((async () => {
      assert.equal(response.ok(), true, response.url());
      return (await response.body()).length;
    })());
  });
  const home = screens.find(screen => screen.id === 'home');
  await page.goto(server.url + home.route, { waitUntil: 'networkidle' });
  await page.locator(home.ready).first().waitFor();
  await page.locator(home.tap).tap();
  await page.waitForFunction(home.complete);
  const link = page.locator('[data-inbox-row] h3 a').first();
  assert.match(await link.getAttribute('href'), /^\/home\/card\//);
  assert.ok((await link.innerText()).trim());
  const bytes = (await Promise.all(reads)).reduce((total, size) => total + size, 0);
  t.diagnostic(`Home transferred ${bytes} JavaScript bytes`);
  assert.deepEqual(errors, []);
});

test('React Home phone load waits for bounded inbox and an injected delay fails the unchanged limit', async t => {
  const { runTaskScenario, tasks, applyPhoneProfile } = await import('../scripts/performance-scenarios.mjs');
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(process.cwd(), 'dist/site') } });
  t.after(() => server.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const task = tasks.find(task => task.id === 'task-react-home');
  for (const delayMs of [75, 4100]) {
    const context = await browser.newContext({ viewport: profile.viewport, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      const cdp = await applyPhoneProfile(context, page);
      const run = () => runTaskScenario({ page, context, origin: server.url, task: { ...task, delayMs }, cdp });
      if (delayMs === 4100) await assert.rejects(run(), /exceeds 4000ms/);
      else { const result = await run(); assert.equal(result.reads.filter(name => name === 'read-home-inbox').length, 1); assert.ok(result.usefulMs <= 4000); }
    } finally { await context.close(); }
  }
});
