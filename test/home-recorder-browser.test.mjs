import test, { before, after } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

let outDir, server, browser, origin;
before(async () => {
  outDir = await temporaryDirectory('home-recorder-');
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  ({ server } = await createQaServer({ buildRoot: join(outDir, 'site') }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

for (const deployment of ['fixture', 'deployed-origin']) for (const path of ['/', '/review-workflows']) {
  for (const recorder of ['absent', 'reachable', 'recording', 'slow']) {
    test(`Home ${path} on ${deployment} with ${recorder} recorder renders quietly before opt-in`, async t => {
      const page = await browser.newPage({ reducedMotion: 'reduce' });
      t.after(() => page.close());
      assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `recorder-${path === '/' ? 'home' : 'review'}-${recorder}`, viewer: 'joe', reset: true } })).status(), 200);
      await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
      const errors = [], requests = [];
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('pageerror', error => errors.push(error.message));
      await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.fulfill({ status: 200, body: '' }));
      if (deployment === 'deployed-origin') await page.route('https://app.doctorcre.com/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const response = await page.request.fetch(`${origin}${url.pathname}${url.search}`, {
          method: request.method(), data: request.postDataBuffer() ?? undefined,
          headers: { 'content-type': request.headers()['content-type'] || 'application/json' },
        });
        await route.fulfill({ response });
      });
      let release;
      const held = new Promise(resolve => { release = resolve; });
      t.after(() => release());
      await page.route('http://127.0.0.1:4682/**', async route => {
        requests.push(route.request().url());
        if (recorder === 'absent') return route.abort('connectionrefused');
        if (recorder === 'slow') await held;
        await route.fulfill({ json: recorder === 'recording'
          ? { state: 'recording', started_at: new Date().toISOString() }
          : { state: 'idle' } }).catch(() => {});
      });
      await page.goto(`${deployment === 'fixture' ? origin : 'https://app.doctorcre.com'}${path}`);
      await page.locator(path === '/' ? '#homeRoot[data-home-ready]' : '#refreshHome[aria-busy="false"]').waitFor();
      if (path === '/') await page.evaluate(async () => (await import('/js/global-call-mode.js')).mountGlobalCallMode(document));
      await page.locator('#callModeRetry').waitFor({ state: 'visible' });
      assert.deepEqual(errors, [], 'Home emits zero console or page errors');
      assert.deepEqual(requests, [], 'Home does not contact an optional recorder');
      if (recorder === 'reachable' || recorder === 'recording') {
        await page.locator('#callModeRetry').click();
        await page.locator('#callModeButton').waitFor({ state: 'visible' });
        assert.ok(requests.length > 0, 'explicit connection reads the recorder');
        if (recorder === 'recording') await page.locator('#callModeButton.recording').waitFor({ state: 'visible' });
        assert.deepEqual(errors, []);
      }
      if (recorder === 'slow') {
        await page.locator('#callModeRetry').click();
        assert.equal(await page.locator('main').isVisible(), true);
        assert.equal(await page.locator('#callModeButton').isVisible(), false);
        release();
        await page.locator('#callModeButton').waitFor({ state: 'visible' });
        assert.deepEqual(errors, []);
      }
    });
  }
}

for (const width of [390, 1440]) for (const transition of ['idle', 'stop', 'stop-error', 'error', 'disconnect', 'cors', 'sign-out']) {
  test(`recorder indicator clears after ${transition} at ${width}px`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
    t.after(() => page.close());
    await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `indicator-${width}-${transition}`, viewer: 'joe', reset: true } });
    await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
    const corsServer = createServer((request, reply) => { reply.setHeader('content-type', 'application/json'); reply.end(JSON.stringify({ state: 'idle' })); });
    await new Promise(resolve => corsServer.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => corsServer.close(resolve)));
    let response = 'recording';
    await page.route('http://127.0.0.1:4682/**', route => {
      if (transition === 'stop-error' && route.request().url().endsWith('/stop')) return route.abort('connectionrefused');
      if (response === 'cors') return route.continue({ url: `http://127.0.0.1:${corsServer.address().port}/api/state` });
      if (response === 'disconnect') return route.abort('connectionrefused');
      return route.fulfill({ json: { state: route.request().url().endsWith('/stop') ? 'transcribing' : response, started_at: new Date().toISOString() } });
    });
    await page.goto(origin);
    await page.locator('#homeRoot[data-home-ready]').waitFor();
    await page.evaluate(async () => { window.recorder = await (await import('/js/global-call-mode.js')).mountGlobalCallMode(document); });
    assert.equal(await page.locator('#callModeButton.recording').count(), 0);
    await page.evaluate(() => window.recorder.checkEligibility());
    await page.waitForFunction(() => document.querySelector('#callModeButton.recording'));
    assert.match(await page.locator('#callModeButton').getAttribute('aria-label'), /recording/);
    if (width === 390) {
      await page.locator('#selfAvatar').click();
      assert.equal(await page.locator('#callModeButton').isVisible(), true);
    }
    if (transition.startsWith('stop')) {
      await page.evaluate(() => window.recorder.open());
      await page.locator('#callModeStop').click();
    } else if (transition === 'sign-out') {
      await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    } else {
      response = transition === 'error' ? 'state_unknown' : transition;
      const eligible = await page.evaluate(() => window.recorder.checkEligibility());
      if (transition === 'disconnect' || transition === 'cors') {
        assert.equal(eligible, false);
        assert.equal(await page.locator('#callModeAvailability').textContent(), 'Call recorder offline');
      }
    }
    await page.waitForFunction(() => !document.querySelector('#callModeButton.recording'));
    assert.doesNotMatch(await page.locator('#callModeButton').getAttribute('aria-label'), /recording/);
    assert.equal(await page.locator('#callModeStage.recording').count(), 0);
    assert.doesNotMatch(await page.locator('#callModeTimer').textContent(), /\d+:\d+/);
    if (width === 390) assert.equal(await page.locator('#selfAvatar').evaluate(node => getComputedStyle(node, '::after').content), 'none');
  });
}

for (const width of [390, 1440]) test(`late recording read cannot restore the indicator after sign-out at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 960 } });
  t.after(() => page.close());
  await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `indicator-late-${width}`, viewer: 'joe', reset: true } });
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  let pending = false;
  await page.route('http://127.0.0.1:4682/**', async route => {
    if (pending) { started(); await held; }
    await route.fulfill({ json: { state: 'recording', started_at: new Date().toISOString() } });
  });
  await page.goto(origin);
  await page.locator('#homeRoot[data-home-ready]').waitFor();
  await page.evaluate(async () => { window.recorder = await (await import('/js/global-call-mode.js')).mountGlobalCallMode(document); await window.recorder.checkEligibility(); });
  await page.waitForFunction(() => document.querySelector('#callModeButton.recording'));
  pending = true;
  const reading = page.evaluate(() => window.recorder.checkEligibility());
  await requested;
  await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
  release(); await reading;
  assert.equal(await page.locator('#callModeButton.recording, #callModeStage.recording').count(), 0);
  assert.doesNotMatch(await page.locator('#callModeButton').getAttribute('aria-label'), /recording/);
});
