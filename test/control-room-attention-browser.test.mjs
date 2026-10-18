import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from '../scripts/fixture-server.mjs';

async function open(t, tab, width = 390, theme = 'dark') {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 }, hasTouch: width === 390 });
  await page.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
  await page.goto(`${server.url}/control-room?tab=${tab}`, { waitUntil: 'networkidle' });
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  return page;
}

for (const theme of ['dark', 'light']) test(`phone Waiting exposes all decision subjects and actions in ${theme}`, async t => {
  const page = await open(t, 'waiting', 390, theme);
  const rows = page.locator('#crWaitingList .cr-row');
  assert.equal(await rows.count(), 5);
  const layout = await rows.evaluateAll(rows => rows.map(row => {
    const title = row.querySelector('.cr-row-title'), action = row.querySelector('.cr-row-meta');
    return { titleWidth: title.clientWidth, titleHeight: title.clientHeight, titleScroll: title.scrollHeight,
      titleBottom: title.getBoundingClientRect().bottom, actionTop: action.getBoundingClientRect().top,
      actionWidth: action.clientWidth, actionScroll: action.scrollWidth, actionClip: getComputedStyle(action).clipPath };
  }));
  for (const row of layout) {
    assert.ok(row.titleWidth > 300, 'decision title uses the phone row width');
    assert.ok(row.titleHeight >= 19 && row.titleHeight <= 44, 'decision title fits within two readable lines');
    assert.ok(row.titleScroll <= row.titleHeight + 1, 'decision subject is visible');
    assert.ok(row.actionTop >= row.titleBottom, 'next action has its own line');
    assert.ok(row.actionWidth > 300 && row.actionScroll <= row.actionWidth + 1, 'entire action fits');
    assert.equal(row.actionClip, 'none');
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

for (const theme of ['dark', 'light']) test(`phone Inbox keeps full reasons, category labels and times in ${theme}`, async t => {
  const page = await open(t, 'inbox', 390, theme);
  const rows = page.locator('#crInboxList .cr-row');
  assert.equal(await rows.count(), 6);
  const layout = await rows.evaluateAll(rows => rows.map(row => {
    const title = row.querySelector('.cr-row-title'), category = row.querySelector('.cr-row-ref'), time = row.querySelector('.cr-row-meta');
    return { titleWidth: title.clientWidth, titleHeight: title.clientHeight, titleScroll: title.scrollHeight,
      titleTop: title.getBoundingClientRect().top, categoryBottom: category.getBoundingClientRect().bottom,
      categoryWidth: category.clientWidth, categoryScroll: category.scrollWidth,
      timeWidth: time.clientWidth, timeClip: getComputedStyle(time).clipPath, time: time.textContent };
  }));
  for (const row of layout) {
    assert.ok(row.titleWidth > 300, 'reason uses the phone row width');
    assert.ok(row.titleScroll <= row.titleHeight + 1, 'whole reason is readable');
    assert.ok(row.titleTop >= row.categoryBottom, 'category sits above reason');
    assert.ok(row.categoryScroll <= row.categoryWidth + 1, 'category is readable');
    assert.ok(row.timeWidth > 40, 'timestamp has visible space');
    assert.equal(row.timeClip, 'none');
    assert.match(row.time, /\d.*[AP]M/);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

for (const width of [390, 1440]) test(`Inbox opens the selected item detail and returns focus at ${width}`, async t => {
  const page = await open(t, 'inbox', width);
  const first = page.locator('#crInboxList .cr-row').first();
  const reason = await first.locator('.cr-row-title').textContent();
  const clock = await first.locator('.cr-row-meta').textContent();
  if(width === 390) await first.tap(); else await first.click();
  const dialog = page.getByRole('dialog', { name: 'Inbox item', exact: true });
  await dialog.waitFor({ timeout: 2500 });
  assert.ok((await dialog.innerText()).includes(reason));
  assert.ok((await dialog.innerText()).includes(clock));
  assert.ok((await dialog.innerText()).includes('Record unavailable in this app'));
  assert.equal(await dialog.getByRole('link').count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await first.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  await dialog.waitFor({ timeout: 2500 });
  await dialog.getByRole('button', { name: 'Close inbox item', exact: true }).click();
  assert.equal(await first.evaluate(node => node === document.activeElement), true);
  const second = page.locator('#crInboxList .cr-row').nth(1);
  const secondReason = await second.locator('.cr-row-title').textContent();
  await second.focus();
  await page.keyboard.press('Space');
  await dialog.waitFor({ timeout: 2500 });
  assert.ok((await dialog.innerText()).includes(secondReason));
  assert.ok(!(await dialog.innerText()).includes(reason));
  await page.keyboard.press('Escape');
  await page.locator('#crInboxList .cr-row').nth(4).click();
  assert.ok((await dialog.innerText()).includes('Demo document conversation is waiting on your answer'));
  assert.equal(await dialog.getByRole('link').count(), 0);
});
