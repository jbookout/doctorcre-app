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
        if (options?.docContext !== false) return client;
        window.ideaRows = [{number: '12', kind: 'idea', label: 'Synthetic focus idea', owner: 'joe', version: 1}];
        client.readLoop = async () => ({loop: {...window.ideaRows[0], title: 'Synthetic focus idea'}});
        window.ideaReads = 0;
        client.loopBoard = async args => {
          ++window.ideaReads;
          const payload = {loops: [...window.ideaRows]};
          if (window.holdIdeas) await new Promise(resolve => { (window.ideaResponses ||= []).push(resolve); });
          return payload;
        };
        const events = client.listIndustryEvents;
        client.listIndustryEvents = async args => {
          const payload = await events.call(client, args);
          if (window.holdEvents) await new Promise(resolve => { window.releaseEvents = resolve; });
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

async function refreshIdeas(page) {
  await page.waitForLoadState('networkidle');
  const before = await page.evaluate(() => window.ideaReads);
  await page.clock.setSystemTime(new Date(await page.evaluate(() => Date.now()) + 60_001));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  for (let turn = 0; turn < 12; turn++) {
    await page.clock.runFor(5_001);
    if (await page.evaluate(before => window.ideaReads > before, before)) return;
  }
  assert.fail('Ideas did not receive its queued refresh');
}

test('Ideas Back returns focus to the current tile after a refresh replaces its opener', async t => {
  const page = await open(t);
  const tile = page.locator('.idea-tile').first();
  const number = await tile.getAttribute('data-idea');
  await tile.focus();
  await page.keyboard.press('Enter');
  await page.locator('#ideaDialog').waitFor({state: 'visible'});
  await page.evaluate(() => { window.openerTile = document.querySelector('.idea-tile'); });
  await refreshIdeas(page);
  await waitForAsync(page, () => !window.openerTile.isConnected);
  await page.evaluate(() => {
    window.ideaClosed = false; document.querySelector('#ideaDialog').addEventListener('close', () => { window.ideaClosed = true; }, {once: true});
  });
  await page.goBack();
  await waitForAsync(page, () => window.ideaClosed);
  assert.deepEqual(await page.evaluate(() => ({id: document.activeElement?.id, tag: document.activeElement?.tagName, idea: document.activeElement?.dataset.idea})), {id: '', tag: 'BUTTON', idea: number});
});

for (const moved of [false, true]) {
  test(`Ideas refresh finishing after close ${moved ? 'preserves moved focus' : 'keeps focus on the current tile'}`, async t => {
    const page = await open(t);
    const tile = page.locator('.idea-tile').first();
    const number = await tile.getAttribute('data-idea');
    await tile.focus();
    await page.keyboard.press('Enter');
    await page.locator('#ideaDialog').waitFor({state: 'visible'});
    await page.evaluate(() => { window.holdIdeas = true; });
    await refreshIdeas(page);
    await waitForAsync(page, () => window.ideaResponses?.length > 0);
    await page.evaluate(() => {
      window.ideaClosed = false; document.querySelector('#ideaDialog').addEventListener('close', () => { window.ideaClosed = true; }, {once: true});
    });
    await page.locator('#ideaDialogClose').click();
    await waitForAsync(page, () => window.ideaClosed);
    if (moved) await page.locator('#ideaSearch').focus();
    await page.evaluate(() => { window.oldTile = document.querySelector('.idea-tile'); window.holdIdeas = false; window.ideaResponses.splice(0).forEach(resolve => resolve()); });
    await waitForAsync(page, () => !window.oldTile.isConnected);
    assert.equal(await page.evaluate(moved => moved ? document.activeElement.id : document.activeElement.dataset.idea, moved), moved ? 'ideaSearch' : number);
  });
}

for (const moved of [false, true]) {
  test(`Event save refresh ${moved ? 'preserves moved focus' : 'restores stranded focus'}`, async t => {
    const page = await open(t, 'events');
    await page.locator('#eventAdd').click();
    await page.locator('#eventTitle').fill('Synthetic focus event');
    await page.locator('#eventOrganizer').fill('Synthetic organizer');
    await page.locator('#eventOwner').selectOption('joe');
    await page.locator('#eventStarts').fill('2026-11-01T10:00');
    await page.locator('#eventEnds').fill('2026-11-01T11:00');
    await page.locator('#eventSourceInput').fill('Synthetic invitation');
    await page.evaluate(() => { window.holdEvents = true; });
    await page.locator('#eventSave').click();
    await waitForAsync(page, () => Boolean(window.releaseEvents) && !document.querySelector('#eventDialog').open);
    if (moved) await page.locator('#eventAdd').focus();
    else await page.evaluate(() => document.activeElement.blur());
    await page.evaluate(() => { window.holdEvents = false; window.releaseEvents(); });
    await waitForAsync(page, () => [...document.querySelectorAll('.event-card')].some(card => card.textContent.includes('Synthetic focus event')));
    assert.equal(await page.evaluate(moved => moved ? document.activeElement.id : document.activeElement.matches('.event-card') && document.activeElement.textContent.includes('Synthetic focus event'), moved), moved ? 'eventAdd' : true);
  });
}

for (const scenario of ['removed', 'moved']) {
  test(`Ideas close after refresh handles ${scenario === 'removed' ? 'a missing opener' : 'focus moved before queued cleanup'}`, async t => {
    const page = await open(t);
    await page.locator('.idea-tile').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('#ideaDialog').waitFor({state: 'visible'});
    await page.evaluate(removed => {
      window.openerTile = document.querySelector('.idea-tile');
      if (removed) window.ideaRows = [];
    }, scenario === 'removed');
    await refreshIdeas(page);
    await waitForAsync(page, () => !window.openerTile.isConnected);
    await page.evaluate(moved => {
      const dialog = document.querySelector('#ideaDialog');
      window.ideaClosed = false;
      dialog.addEventListener('close', () => { window.ideaClosed = true; }, {once: true});
      dialog.close();
      if (moved) document.querySelector('#ideaSearch').focus();
    }, scenario === 'moved');
    await waitForAsync(page, () => window.ideaClosed);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ideaSearch');
  });
}
