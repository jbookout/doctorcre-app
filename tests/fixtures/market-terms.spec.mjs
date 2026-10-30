import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
let server;
test.beforeAll(async () => { server = await startFixtureServer(); await mkdir('.github/pr-evidence/WR39.S6.J4', {recursive:true}); });
test.afterAll(async () => { await server.stop(); });
for (const width of [390,1440]) for (const theme of ['light','dark']) {
  test(`comparison at ${width} ${theme}`, async ({page}) => {
    await page.setViewportSize({width,height:width === 390 ? 844 : 900});
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
    await page.screenshot({path:`.github/pr-evidence/WR39.S6.J4/terms-${width}-${theme}.png`,fullPage:width !== 390});
  });
}

test('comparison cleans stored deal names', async ({page}) => {
  const seed = JSON.parse(await readFile(new URL('../../data/board-seed.json', import.meta.url), 'utf8'));
  seed.deals.find(deal => deal.id === 'd14').name = JSON.stringify({value:'Demo Surgical Practice'});
  await page.route('**/data/board-seed.json', route => route.fulfill({json:seed}));
  await page.goto(`${server.url}/deals?deal=d14`);
  await page.getByRole('tab', {name:'Compare terms'}).click();
  await expect(page.locator('.market-terms-table td[data-label="Deal"] a')).toHaveText('Demo Surgical Practice');
});

test('comparison resets when the signed-in user changes', async ({page}) => {
  await page.goto(`${server.url}/deals?deal=d14`);
  await page.getByRole('tab', {name:'Compare terms'}).click();
  const filter = page.locator('#workspace-market-terms input[name=submarket]');
  await filter.fill('Previous user selection');
  await page.evaluate(async () => {
    const {state} = await import('/js/pipeline.js');
    const read = state.client.getBoard.bind(state.client);
    state.client.getBoard = async (...args) => ({...await read(...args), actor: state.selfActor === 'dell' ? 'joe' : 'dell'});
    await state.boardSync.refreshBoard({reason:'synthetic-account-change'});
  });
  await expect(filter).not.toHaveValue('Previous user selection');
});
