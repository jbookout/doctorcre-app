import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium } from './browser-harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let outDir, server, browser, origin;
before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'home-call-actions-'));
  await buildArtifact({ root, outDir });
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

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  test(`signed-in Home shows dated and undated call actions at ${width}px in ${theme}`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 960 }, timezoneId: 'America/Chicago', reducedMotion: 'reduce' });
    t.after(() => page.close());
    await page.clock.install({ time: new Date('2026-10-01T15:00:00Z') });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    const viewer = theme === 'light' ? 'joe' : 'dell';
    assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `home-${width}-${theme}`, viewer, reset: true } })).status(), 200);
    const identity = await page.request.get(`${origin}/api/test/identity`);
    assert.equal((await identity.json()).viewer, viewer);
    const errors = [], detailReads = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/mcp', async route => {
      const rpc = route.request().postDataJSON();
      if (rpc.params.name !== 'get-deal-room') return route.continue();
      detailReads.push(rpc.params.arguments.deal);
      const response = await route.fetch();
      const envelope = await response.json();
      const detail = JSON.parse(envelope.result.content[0].text);
      const action = (id, due_on, owner = 'joe') => ({ id, description: `Demo call ${id}`, owner, due_on, status: 'open' });
      detail.next_actions = detail.deal_id === 'qa-deal-1' ? [
        action('undated', null, 'dell'), action('future', '2026-10-02'),
        action('today', '2026-10-01'), action('overdue', '2026-09-30'),
        action('also-undated', null), { ...action('done', null), status: 'done' },
      ] : [];
      envelope.result.content[0].text = JSON.stringify(detail);
      await route.fulfill({ response, json: envelope });
    });
    await page.goto(`${origin}/?mode=live`);
    await page.locator('#refreshHome[aria-busy="false"]').waitFor();
    if (process.env.HOME_ACTION_SCREENSHOT_DIR) {
      await mkdir(process.env.HOME_ACTION_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.HOME_ACTION_SCREENSHOT_DIR, `${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
    const rows = page.locator('#homeCalendar .home-agenda > a');
    assert.deepEqual(await rows.locator('strong').allTextContents(), [
      'Demo call overdue', 'Demo call today', 'Demo call also-undated', 'Demo call undated', 'Demo call future',
    ]);
    const undated = rows.filter({ hasText: 'Demo call undated' });
    assert.match(await undated.innerText(), /No date/);
    assert.match(await undated.innerText(), /Dell/);
    assert.equal(await undated.getAttribute('href'), '/deals?deal=qa-deal-1');
    assert.equal(await undated.locator('time').count(), 0);
    assert.equal(await rows.locator('time').count(), 3);
    assert.equal(await page.locator('#homeCalendar .home-partial').count(), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /Nothing needs you|Invalid Date|Demo call done/i);
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(detailReads.length, 16);
    assert.equal(new Set(detailReads).size, 16, 'reuse each existing deal read once');
    await page.getByRole('button', { name: 'Just me', exact: true }).click();
    assert.equal(await rows.count(), viewer === 'joe' ? 4 : 0);
    assert.deepEqual(errors, []);
  });
}
