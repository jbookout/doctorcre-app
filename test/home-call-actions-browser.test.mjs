import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

for (const actionCount of [5, 30]) for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  test(`signed-in Home brief shows ${actionCount} call actions at ${width}px in ${theme}`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 960 }, timezoneId: 'America/Chicago', reducedMotion: 'reduce' });
    t.after(() => page.close());
    await page.clock.install({ time: new Date('2026-10-01T15:00:00Z') });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
    const viewer = theme === 'light' ? 'joe' : 'dell';
    assert.equal((await page.request.post(`${origin}/api/test/seed`, { data: { namespace: `home-${actionCount}-${width}-${theme}`, viewer, reset: true } })).status(), 200);
    const identity = await page.request.get(`${origin}/api/test/identity`);
    assert.equal((await identity.json()).viewer, viewer);
    const errors = [], detailReads = [];
    let undatedOnly = false, refreshed = false, agendaReads = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/mcp', async route => {
      const rpc = route.request().postDataJSON();
      if (rpc.params.name === 'get-deal-room') detailReads.push(rpc.params.arguments.deal);
      if (rpc.params.name !== 'read-home-agenda') return route.continue();
      agendaReads++;
      const response = await route.fetch();
      const envelope = await response.json();
      const agenda = JSON.parse(envelope.result.content[0].text);
      const action = (id, due_on, owner = 'joe') => ({ id, description: `Demo call ${id}`, owner, due_on, status: 'open' });
      for (const detail of agenda.deals) {
        detail.next_actions = detail.id === 'qa-deal-1' ? [
          action('undated', null, 'dell'), action('future', '2026-10-02'),
          action('today', '2026-10-01'), action('overdue', '2026-09-30'),
          action('also-undated', null), { ...action('done', null), status: 'done' },
        ] : [];
        if (actionCount === 30 && detail.id === 'qa-deal-1') detail.next_actions.push(...Array.from({ length: 25 }, (_, i) => action(`extra-${String(i + 1).padStart(2, '0')}`, '2026-10-03')));
        if (refreshed && actionCount === 30 && detail.id === 'qa-deal-1') detail.next_actions.at(-1).description = 'Demo updated call';
        if (undatedOnly) detail.next_actions = detail.next_actions.filter(row => row.due_on === null);
      }
      envelope.result.content[0].text = JSON.stringify(agenda);
      await route.fulfill({ response, json: envelope });
    });
    await page.goto(`${origin}/?mode=live`);
    await page.locator('#refreshHome[aria-busy="false"]').waitFor();
    await page.locator('#homeCalendar').evaluate(node => node.scrollIntoView({ block: 'center' }));
    const panel = await page.locator('#homeCalendar').boundingBox();
    const grid = await page.locator('.home-grid').boundingBox();
    if (width === 1280) assert.ok(panel.width >= grid.width - 1, 'the agenda uses the desktop grid width');
    assert.ok(panel.height < 1000, 'the preview stays bounded with 5 or 30 actions');
    if (process.env.HOME_ACTION_SCREENSHOT_DIR) {
      await mkdir(process.env.HOME_ACTION_SCREENSHOT_DIR, { recursive: true });
      const capture = join(process.env.HOME_ACTION_SCREENSHOT_DIR, `${actionCount}-${width}-${theme}`);
      await page.screenshot({ path: `${capture}.png`, animations: 'disabled' });
      await page.locator('#homeCalendar').screenshot({ path: `${capture}-panel.png`, animations: 'disabled' });
      await writeFile(`${capture}.json`, JSON.stringify({ actionCount, width, theme, viewer, panel, grid }, null, 2));
    }
    const rows = page.locator('#homeBrief > a');
    const firstFive = ['Demo call overdue', 'Demo call today', 'Demo call also-undated', 'Demo call undated', 'Demo call future'];
    assert.deepEqual(await rows.locator('strong').allTextContents(), [...firstFive,
      ...(actionCount === 30 ? Array.from({ length: 25 }, (_, i) => `Demo call extra-${String(i + 1).padStart(2, '0')}`) : [])]);
    if (actionCount === 30) {
      refreshed = true;
      await page.locator('#refreshHome').click();
      await page.locator('#refreshHome[aria-busy="false"]').waitFor();
      assert.equal(await rows.count(), 30, 'refresh retains every task');
      assert.equal(await rows.last().locator('strong').textContent(), 'Demo updated call', 'new data repaints the brief');
      await page.getByRole('button', { name: 'Team view', exact: true }).click();
      assert.equal(await rows.count(), 30, 'reselecting the same scope keeps every task');
    }
    const undated = rows.filter({ hasText: 'Demo call undated' });
    assert.match(await undated.innerText(), /No due date/);
    assert.match(await undated.innerText(), /Dell/);
    assert.equal(await undated.getAttribute('href'), '/deals?deal=qa-deal-1');
    assert.equal(await undated.locator('time').count(), 0);
    assert.equal(await rows.locator('time').count(), actionCount === 5 ? 3 : 28);
    assert.equal(await page.locator('#homeCalendar .home-partial').count(), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /Nothing needs you|Invalid Date|Demo call done/i);
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(detailReads.length, 0, 'Home never opens complete records');
    assert.equal(agendaReads, actionCount === 5 ? 1 : 2, 'one agenda read per refresh');
    await page.getByRole('button', { name: 'Just me', exact: true }).click();
    assert.equal(await page.locator('#homeCalendar').isVisible(), true);
    if (viewer !== 'joe') assert.equal(await rows.count(), 0);
    if (viewer === 'joe') assert.equal(await rows.count(), actionCount === 5 ? 4 : 29, 'personal scope includes only the viewer’s tasks');
    await page.getByRole('button', { name: 'Team view', exact: true }).click();
    assert.equal(await rows.count(), actionCount, 'team scope restores every open task');
    undatedOnly = true;
    await page.locator('#refreshHome').click();
    await page.locator('#refreshHome[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('#homeCalendar').isVisible(), true);
    assert.equal(await rows.count(), 2, 'a Home with only undated actions still shows its list');
    assert.equal(await rows.locator('time').count(), 0);
    assert.deepEqual(errors, []);
  });
}
