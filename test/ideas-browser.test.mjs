import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

async function settleIdeaRefresh(page, before) {
  for (let turn = 0; turn < 40; turn++) {
    if (await page.locator('#ideaAsOf').textContent() !== before) return;
    await page.evaluate(() => document.dispatchEvent(new Event('pointermove')));
    const delay = await page.evaluate(async () => Math.max(5_001, (await import('/js/poll-safety.mjs')).pollSafety(window).state().nextAt - Date.now() + 1));
    await page.clock.fastForward(delay);
    await page.waitForTimeout(30);
  }
  assert.fail('Ideas did not finish its queued refresh');
}

test('S3 closing an idea restores stranded focus and preserves keyboard navigation', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const artifacts = new URL('../out/test-artifacts/s3-verification/', import.meta.url);
  await mkdir(artifacts, { recursive: true });
  for (const width of [1440, 390]) for (const theme of ['dark', 'light']) for (const dismiss of ['escape', 'button', 'fast-tab']) {
    await t.test(`${width} ${theme} ${dismiss}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 960 }, reducedMotion: 'reduce', timezoneId: 'UTC' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({ time: new Date('2026-10-01T15:00:00Z') });
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
      await page.route('**/api/**', route => route.fulfill({ json: {} }));
      await page.route('**/js/fixture-client.js', route => route.fulfill({ contentType: 'text/javascript', body: `
        import { createFixtureClient as base } from '/js/fixture-client.js?s3-original';
        export async function createFixtureClient(options) {
          const client = await base(options);
          await client.addLoop({ idempotency_key: crypto.randomUUID(), kind: 'idea', owner: 'joe', title: 'Demo referral lunch', body: 'Demo idea description' });
          await client.addLoop({ idempotency_key: crypto.randomUUID(), kind: 'idea', owner: 'joe', title: 'Demo second idea', body: 'Demo second description' });
          const board = client.loopBoard.bind(client);
          client.loopBoard = async args => { const result = await board(args); return { ...result, loops: result.loops.map(row => ({ ...row, label: row.title })) }; };
          return client;
        }
      ` }));
      await page.goto(`${server.origin}/ideas?mode=fixture`);
      const card = page.locator('.idea-tile').first();
      await card.waitFor({ state: 'visible' });
      const number = await card.getAttribute('data-idea');
      const before = await page.locator('#ideaAsOf').textContent();
      await card.focus();
      await page.keyboard.press('Enter');
      await page.locator('#ideaDialogBody .idea-rows').waitFor();
      if (dismiss === 'fast-tab') {
        const next = await page.locator('.idea-tile').nth(1).getAttribute('data-idea');
        for (let trial = 0; trial < 8; trial += 1) {
          if (trial > 0) {
            await card.focus();
            await page.keyboard.press('Enter');
            await page.locator('#ideaDialogBody .idea-rows').waitFor();
          }
          await page.keyboard.press('Escape');
          await page.keyboard.press('Tab');
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.equal(await page.evaluate(() => document.activeElement?.dataset.idea), next, `Tab focus survives queued close, trial ${trial}`);
        }
        assert.deepEqual(errors, []);
        await page.close();
        return;
      }
      await page.clock.setSystemTime(new Date('2026-10-01T15:01:00Z'));
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await settleIdeaRefresh(page, before);
      if (dismiss === 'escape') await page.keyboard.press('Escape');
      else await page.locator('#ideaDialogClose').click();
      await page.waitForFunction(() => !document.querySelector('#ideaDialog').open && !new URLSearchParams(location.search).has('idea'));
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.idea), number);
      await page.screenshot({ path: new URL(`ideas-return-${width}-${theme}-${dismiss}.png`, artifacts).pathname });
      await page.keyboard.press('Enter');
      await page.locator('#ideaDialog').waitFor({ state: 'visible' });
      assert.deepEqual(errors, []);
      await page.close();
    });
  }
});
