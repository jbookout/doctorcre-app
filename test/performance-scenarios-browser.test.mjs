import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { chromium } from 'playwright';
import { profile, screens } from '../scripts/performance-scenarios.mjs';
import { startFixtureServer } from '../scripts/fixture-server.mjs';

test('the phone Relationships performance scenario opens the visible connection detail', async t => {
  const outDir=await mkdtemp(join(tmpdir(),'doctorcre-perf-artifact-'));
  t.after(()=>rm(outDir,{recursive:true,force:true}));
  await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir});
  const server = await startFixtureServer({env:{DOCTORCRE_FIXTURE_ROOT:join(outDir,'site')}});
  t.after(() => server.stop());
  const browser = await chromium.launch();
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
  assert.ok([...scripts.keys()].some(url=>url.endsWith('/js/error-tracking-entry.js')),'budget includes shipped error tracking');
  const budget = JSON.parse(await readFile(new URL('../contracts/performance-budget.v1.json', import.meta.url)));
  const bytes = [...scripts.values()].reduce((total, size) => total + size, 0);
  assert.ok(bytes <= budget.screens.relationships.jsBytes.limit,
    `Relationships loaded ${bytes} JS bytes, budget ${budget.screens.relationships.jsBytes.limit}`);
});

test('phone task guard exercises useful outcomes against the built fixture', async t => {
  const scenarios = await import('../scripts/performance-scenarios.mjs');
  const expected = ['task-agenda', 'task-leads', 'task-deal-link', 'task-deal-draft', 'task-tour-library', 'task-tour-offline'];
  assert.deepEqual(scenarios.tasks?.map(task => task.id), expected);
  const outDir = await mkdtemp(join(tmpdir(), 'doctorcre-task-artifact-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(outDir, 'site') } });
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const task of scenarios.tasks) await t.test(task.id, async () => {
    const context = await browser.newContext({ viewport: profile.viewport, isMobile: true, hasTouch: true,
      serviceWorkers: task.id === 'task-tour-offline' ? 'allow' : 'block' });
    try {
      const page = await context.newPage();
      const result = await scenarios.runTaskScenario({ page, context, origin: server.url, task });
      assert.ok(result.usefulMs > 0);
      assert.ok(Number.isInteger(result.requestCount) && result.requestCount > 0);
      assert.ok(result.criticalBytes > 0);
      assert.equal(result.reads.length, result.requestCount);
      if (task.id === 'task-agenda') {
        assert.equal(result.reads.filter(name => name === 'getDeal').length, 40);
        assert.ok(result.reads.includes('notificationFeed'), 'count the shared shell reads as well as agenda reads');
      }
      assert.deepEqual(result.errors, []);
    } finally { await context.close(); }
  });
});
