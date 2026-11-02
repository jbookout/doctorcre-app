import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

const root = new URL('../', import.meta.url).pathname;
const evidence = process.env.QA_SIGNOUT_SCREENSHOT_DIR;

test('QA real Sign out redirects, revokes only its session, and ends the workspace without auth routes', async t => {
  const outDir = await temporaryDirectory('qa-signout-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: '1'.repeat(40) });
  const { server } = await createQaServer({ buildRoot: join(outDir, 'site') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  if (evidence) await mkdir(evidence, { recursive: true });

  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
    const other = await browser.newContext();
    try {
      const namespace = `signout-${width}-${theme}`;
      await context.request.post(`${origin}/api/test/seed`, { data: { namespace, viewer: 'joe', reset: true } });
      await other.request.post(`${origin}/api/test/seed`, { data: { namespace, viewer: 'dell' } });
      const staleCookies = await context.cookies(origin);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
      await page.goto(`${origin}/?mode=live`);
      await page.getByRole('button', { name: 'Joe: account and settings', exact: true }).waitFor();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      await page.locator('#selfAvatar').press('Enter');
      const button = page.getByRole('button', { name: 'Sign out', exact: true });
      await button.focus();
      assert.equal(await button.evaluate(node => node === document.activeElement), true);
      if (evidence) await page.screenshot({ path: join(evidence, `${width}-${theme}-account.png`), fullPage: true });
      const signouts = [];
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/auth/signout') signouts.push(request.method());
      });
      const sessionStatuses = [];
      page.on('response', response => {
        if (new URL(response.url()).pathname === '/auth/session') sessionStatuses.push(response.status());
      });
      await button.press('Enter');
      await page.getByRole('heading', { name: 'Session ended', exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/public-shell/session-ended.html');
      assert.ok(sessionStatuses.includes(401), 'the app verifies revocation before leaving');
      assert.deepEqual(signouts, ['POST']);
      assert.equal((await context.request.get(`${origin}/auth/session`)).status(), 401);
      assert.equal((await context.cookies(origin)).some(cookie => cookie.name === 'doctorcre_qa'), false);
      assert.equal((await other.request.get(`${origin}/auth/session`)).status(), 200);
      const replay = await other.request.get(`${origin}/auth/session`, {
        headers: { cookie: staleCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') },
      });
      assert.equal(replay.status(), 401, 'the old cookie cannot restore the revoked identity');
      assert.equal(await page.locator('#viewerWorkspace, #selfAvatar').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.getByRole('link', { name: 'Sign in again' }).evaluate(node => node === document.activeElement), true);
      if (evidence) await page.screenshot({ path: join(evidence, `${width}-${theme}-ended.png`), fullPage: true });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await other.close();
    }
  }
});
