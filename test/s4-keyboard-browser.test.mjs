import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`Doc Chats keeps the focused conversation through a background refresh at ${width}px in ${theme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.goto(`${server.origin}/doc-chats`);
    const opener = page.locator('#conversationList [data-open]').first();
    await opener.focus();
    const id = await opener.getAttribute('data-open');
    await page.evaluate(() => {
      const list = document.getElementById('conversationList');
      window.listRefreshed = false;
      const observer = new MutationObserver(() => { window.listRefreshed = true; observer.disconnect(); });
      observer.observe(list, { childList: true });
      dispatchEvent(new Event('online'));
    });
    await page.waitForFunction(() => window.listRefreshed);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.open), id);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('turnList').children.length > 0);
    assert.equal(await page.locator('#conversationId').textContent(), id);
  });
}

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) for (const [route, listId, attribute] of [
  ['/doc-chats', 'outcomeCardsList', 'data-copy-outcome-session'],
  ['/doc-chats/work', 'taskList', 'data-task'],
  ['/doc-chats/work', 'taskList', 'data-handover'],
]) {
  test(`${route} keeps its focused ${attribute} action through a background refresh at ${width}px in ${theme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.goto(`${server.origin}${route}`);
    const action = page.locator(`#${listId} [${attribute}]`).first();
    await action.focus();
    const key = await action.getAttribute(attribute);
    await page.evaluate(listId => {
      window.listRefreshed = false;
      const observer = new MutationObserver(() => { window.listRefreshed = true; observer.disconnect(); });
      observer.observe(document.getElementById(listId), { childList: true });
      dispatchEvent(new Event('online'));
    }, listId);
    await page.waitForFunction(() => window.listRefreshed);
    if (route === '/doc-chats/work') await page.waitForFunction(() => document.getElementById('taskStatusLabel').textContent === 'Current');
    assert.equal(await page.evaluate(attribute => document.activeElement.getAttribute(attribute), attribute), key);
  });
}


test('Doc Chats labels a held initial conversation-list read as loading', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/js/fixture-client.js', async route => {
    let source = await readFile(new URL('../js/fixture-client.js', import.meta.url), 'utf8');
    source = source.replace('export async function createFixtureClient', 'async function originalFixture');
    source += `\nexport async function createFixtureClient(opts) {
      const c = await originalFixture(opts), read = c.listDocConversations;
      c.listDocConversations = async args => {
        window.listReadHeld = true;
        await new Promise(resolve => window.releaseConversationList = resolve);
        return read(args);
      };
      return c;
    }`;
    await route.fulfill({ contentType: 'text/javascript', body: source });
  });
  await page.goto(`${server.origin}/doc-chats`);
  await page.waitForFunction(() => window.listReadHeld);
  assert.equal(await page.locator('#listState').isVisible(), true);
  assert.match(await page.locator('#listStateTitle').textContent(), /Reading|Loading|Updating/);
  await page.evaluate(() => window.releaseConversationList());
  await page.locator('#conversationList [data-open]').first().waitFor();
  assert.equal(await page.locator('#listState').isVisible(), false);
});
