import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { routeLeads } from './leads-browser-fixture.mjs';
import { chromium, fixtureServer } from './browser-harness.mjs';

let server, browser;
before(async () => { server = await fixtureServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.close(); });
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`shared cards at ${width} in ${theme}`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
  for (const [surface, path, selector] of [['email', '/', '#homeEmailFollowups article'], ['deals-board', '/deals', '.kanban-column .kanban-card'], ['deals-list', '/deals?view=list', '.deal-row'], ['leads', '/leads', '.lead-card']]) {
    if (surface === 'leads') await routeLeads(page);
    await page.goto(`${surface === 'leads' ? 'http://localhost' : server.origin}${path}`);
    await page.locator(selector).first().waitFor();
    await page.locator(selector).first().scrollIntoViewIfNeeded();
    const dir = 'out/test-artifacts/card-shape';
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${surface}-${width}-${theme}.png` });
    assert.equal(await page.locator(selector).first().locator('.work-card-title').count(), 1);
    assert.equal(await page.locator(selector).first().locator('.work-card-meta').count(), 1);
    assert.equal(await page.locator(selector).first().locator('.work-card-status').count(), 1);
    for (const target of await page.locator(selector).first().locator('button:visible, a:visible, summary:visible').all()) {
      const box = await target.boundingBox();
      assert.ok(box.height >= 44 && box.width >= 44, `${surface} has 44px targets`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${surface} fits`);
  }
});
