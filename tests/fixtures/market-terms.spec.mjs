import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
let server;
test.beforeAll(async () => { server = await startFixtureServer(); await mkdir('.github/pr-evidence/WR39.S6.J4', {recursive:true}); });
test.afterAll(async () => { await server.stop(); });
for (const width of [390,1440]) for (const theme of ['light','dark']) {
  test(`comparison at ${width} ${theme}`, async ({page}) => {
    await page.setViewportSize({width,height:900});
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({theme})), theme);
    await page.goto(`${server.url}/deals`);
    await expect(page.locator('.card-open:visible').first()).toBeVisible();
    await page.evaluate(async () => {
      const {state} = await import('/js/pipeline.js');
      const read = state.client.readMarketTerms.bind(state.client);
      window.marketReads = 0;
      state.client.readMarketTerms = args => { window.marketReads++; return read(args); };
    });
    await page.locator('.card-open:visible').first().click();
    expect(await page.evaluate(() => window.marketReads)).toBe(0);
    await page.getByRole('tab', {name:'Compare terms'}).click();
    await expect.poll(() => page.evaluate(() => window.marketReads)).toBe(1);
    await expect(page.locator('#workspace-market-terms')).toContainText('fixture-lease');
    await expect(page.locator('#workspace-market-terms')).toContainText('Demo Surgical Practice');
    await page.getByRole('tab', {name:'Overview'}).click();
    await page.getByRole('tab', {name:'Compare terms'}).click();
    expect(await page.evaluate(() => window.marketReads)).toBe(1);
    await expect(page.locator('#workspace-market-terms')).toContainText('1 of 20 receipts eligible; 7 unsupported, 4 superseded without context, 8 unclassified');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#workspace-market-terms p').last().scrollIntoViewIfNeeded();
    await page.screenshot({path:`.github/pr-evidence/WR39.S6.J4/terms-${width}-${theme}.png`,fullPage:true});
  });
}
