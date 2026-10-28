import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('going offline clears health during a pending refresh and reconnect reads again', async ({ page, context }) => {
  let releaseFeed;
  const pendingFeed = new Promise(resolve => { releaseFeed = resolve; });
  let boardReads = 0;
  await page.clock.install();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/connection-fixture') return route.fulfill({ contentType: 'text/html', body:
      '<header id="shell"></header><main><h1>Connection fixture</h1></main><script type="module">import {mountAppLayout} from "/js/app-layout.js";mountAppLayout(document,document.querySelector("#shell"),"/search");</script>' });
    if (['/api/system-work/session','/auth/session'].includes(url.pathname)) return route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-session'}});
    if (url.pathname === '/mcp') {
      const name = route.request().postDataJSON().params.name;
      if (name === 'deal-room-board') boardReads++;
      const payload = name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
      return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
    }
    if (url.pathname === '/pipeline/changes') {
      await pendingFeed;
      return route.fulfill({ json: { events: [], cursor: null } });
    }
    try { return route.fulfill({ body: await readFile(new URL(`../../${url.pathname.slice(1)}`, import.meta.url)), contentType: 'text/javascript' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  const feedRead = page.waitForRequest(request => new URL(request.url()).pathname === '/pipeline/changes');
  await page.goto('http://localhost/connection-fixture?mode=live');
  const connection = page.locator('#appConnection');
  await expect(connection).toHaveAttribute('aria-label', 'Connection available');
  await feedRead;
  try {
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Refresh workspace' }).click();
    await expect(connection).toHaveAttribute('aria-label', 'Connection unavailable');
    await expect(page.locator('#appTodayNeeds')).toHaveText('—');
    await expect(page.getByRole('button', { name: 'Retry Today', exact: true })).toBeVisible();
    await expect(page.locator('#appTodayReadStatus')).toContainText('Showing last update');
    expect(boardReads).toBe(1);
    const feedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/pipeline/changes');
    releaseFeed();
    await (await feedResponse).finished();
    await expect(connection).toHaveAttribute('aria-label', 'Connection unavailable');
    await expect(page.locator('#appTodayMoves')).toHaveText('Unavailable');
  } finally {
    releaseFeed();
    await context.setOffline(false);
  }
  await expect.poll(() => boardReads).toBe(2);
  await expect(connection).toHaveAttribute('aria-label', 'Connection available');
});
