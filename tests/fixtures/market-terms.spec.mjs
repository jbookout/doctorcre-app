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
    await page.locator('.card-open:visible').first().click();
    await page.getByRole('tab', {name:'Compare terms'}).click();
    await expect(page.locator('#workspace-market-terms')).toContainText('fixture-lease');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:`.github/pr-evidence/WR39.S6.J4/terms-${width}-${theme}.png`,fullPage:true});
  });
}
