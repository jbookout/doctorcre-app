import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium, fixtureServer, pausedClock, waitForAsync} from './browser-harness.mjs';

async function open(t, tab = 'ideas') {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({reducedMotion: 'reduce'});
  await pausedClock(page, new Date('2026-10-01T15:00:00Z'));
  await page.route('**/api/**', route => route.fulfill({json: {}}));
  await page.route('**/js/fixture-client.js', async route => {
    let source = await readFile(new URL('../js/fixture-client.js', import.meta.url), 'utf8');
    source = source.replace('export async function createFixtureClient', 'async function originalFixture');
    source += `
      export async function createFixtureClient(options) {
        const client = await originalFixture(options);
        window.ideaRows = [{number: '12', kind: 'idea', label: 'Synthetic focus idea', owner: 'joe', version: 1}];
        client.readLoop = async () => ({loop: {...window.ideaRows[0], title: 'Synthetic focus idea'}});
        window.ideaReads = 0;
        client.loopBoard = async args => {
          ++window.ideaReads;
          const payload = {loops: [...window.ideaRows]};
          if (window.holdIdeas) await new Promise(resolve => { window.releaseIdeas = resolve; });
          return payload;
        };
        return client;
      }`;
    await route.fulfill({contentType: 'text/javascript', body: source});
  });
  await page.goto(`${server.origin}/ideas?mode=fixture&tab=${tab}`);
  await waitForAsync(page, () => Boolean(document.querySelector('.idea-tile')));
  return page;
}

test('Ideas Back returns focus to the current tile after a refresh replaces its opener', async t => {
  const page = await open(t);
  const tile = page.locator('.idea-tile').first();
  const number = await tile.getAttribute('data-idea');
  await tile.focus();
  await page.keyboard.press('Enter');
  await page.locator('#ideaDialog').waitFor({state: 'visible'});
  await page.evaluate(() => { window.openerTile = document.querySelector('.idea-tile'); });
  await page.clock.fastForward(30_000);
  await waitForAsync(page, () => !window.openerTile.isConnected);
  await page.evaluate(() => {
    window.ideaClosed = new Promise(resolve => document.querySelector('#ideaDialog').addEventListener('close', resolve, {once: true}));
  });
  await page.goBack();
  await page.evaluate(() => window.ideaClosed.then(() => {}));
  assert.deepEqual(await page.evaluate(() => ({id: document.activeElement?.id, tag: document.activeElement?.tagName, idea: document.activeElement?.dataset.idea})), {id: '', tag: 'BUTTON', idea: number});
});
