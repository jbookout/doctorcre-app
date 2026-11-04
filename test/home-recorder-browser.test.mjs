import test, { before, after } from 'node:test';
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

for (const path of ['/', '/review-workflows']) {
  for (const recorder of ['absent', 'reachable', 'slow']) {
    test(`Home ${path} with ${recorder} recorder renders quietly before opt-in`, async t => {
      const page = await browser.newPage({ reducedMotion: 'reduce' });
      t.after(() => page.close());
      assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `recorder-${path === '/' ? 'home' : 'review'}-${recorder}`, viewer: 'joe', reset: true } })).status(), 200);
      await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
      const errors = [], requests = [];
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('pageerror', error => errors.push(error.message));
      await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.fulfill({ status: 200, body: '' }));
      let release;
      const held = new Promise(resolve => { release = resolve; });
      t.after(() => release());
      await page.route('http://127.0.0.1:4682/**', async route => {
        requests.push(route.request().url());
        if (recorder === 'absent') return route.abort('connectionrefused');
        if (recorder === 'slow') await held;
        await route.fulfill({ json: { state: 'idle' } }).catch(() => {});
      });
      await page.goto(`${origin}${path}`);
      await page.locator(path === '/' ? '#homeRoot[data-home-ready]' : '#refreshHome[aria-busy="false"]').waitFor();
      await page.locator('#callModeRetry').waitFor({ state: 'visible' });
      assert.deepEqual(errors, [], 'Home emits zero console or page errors');
      assert.deepEqual(requests, [], 'Home does not contact an optional recorder');
      if (recorder === 'reachable') {
        await page.locator('#callModeRetry').click();
        await page.locator('#callModeButton').waitFor({ state: 'visible' });
        assert.ok(requests.length > 0, 'explicit connection reads the recorder');
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
