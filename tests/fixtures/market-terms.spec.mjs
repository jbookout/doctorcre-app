import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { ownedServer as startFixtureServer } from '../../test/fixture-probe.ts';
let server;
test.beforeAll(async () => { server = await startFixtureServer(); await mkdir('.github/pr-evidence/WR39.S6.J21', {recursive:true}); });
test.afterAll(async () => { await server.stop(); });
for (const width of [390,1280]) for (const theme of ['light','dark']) {
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
    await expect(page.locator('#workspace-market-terms [data-label=Source] strong')).toHaveText(' — Quarantined: not supporting evidence');
    await expect(page.locator('#workspace-market-terms')).toContainText('fixture-lease');
    await expect(page.locator('#workspace-market-terms')).toContainText('Demo Surgical Practice');
    await page.getByRole('tab', {name:'Overview'}).click();
    await page.getByRole('tab', {name:'Compare terms'}).click();
    expect(await page.evaluate(() => window.marketReads)).toBe(1);
    await expect(page.locator('#workspace-market-terms')).toContainText('1 of 20 receipts eligible; 7 unsupported, 4 superseded without context, 8 unclassified');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:`.github/pr-evidence/WR39.S6.J21/terms-${width}-${theme}.png`,fullPage:width !== 390});
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

for (const width of [390,1280]) for (const theme of ['light','dark']) {
  test(`historical terms at ${width} ${theme}`, async ({page}) => {
    await page.setViewportSize({width,height:width === 390 ? 844 : 900});
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({theme})), theme);
    await page.goto(`${server.url}/deals?deal=d14`);
    await expect(page.getByRole('tab', {name:'Compare terms'})).toBeVisible();
    await page.evaluate(async () => {
      const {state} = await import('/js/pipeline.js');
      const response = await state.client.readMarketTerms({});
      const old = {...response.rows[0],value:'31',effective_from:'2024-01-01',effective_to:'2025-01-01'};
      const current = {...old,value:'39',effective_from:'2025-01-01',effective_to:null};
      window.marketRequests = [];
      window.marketPending = [];
      state.client.readMarketTerms = args => {
        window.marketRequests.push(args);
        if (args.as_of === '2024-06-01') return new Promise(resolve => window.marketPending.push(() => resolve({...response,rows:[old]})));
        if (args.as_of === '2023-01-01') return Promise.resolve({...response,rows:[]});
        if (args.as_of === '2022-01-01') return Promise.reject(Object.assign(new Error('Synthetic refusal'), {status:403}));
        if (args.as_of === '2021-01-01') return Promise.reject(Object.assign(new Error('Synthetic unavailable'), {status:404}));
        if (args.as_of === '2020-01-01') return Promise.reject(Object.assign(new Error('Synthetic expiry'), {status:401}));
        return Promise.resolve({...response,rows:args.as_of ? [args.as_of < '2025-01-01' ? old : current] : [old,current]});
      };
    });
    await page.getByRole('tab', {name:'Compare terms'}).click();
    const root = page.locator('#workspace-market-terms');
    const date = root.getByLabel('As of date (optional)');
    const compare = root.getByRole('button', {name:'Compare',exact:true});
    const results = root.locator('[data-market-results]');
    await expect(results).toContainText('All recorded history');
    await expect(root.locator('tbody tr')).toHaveCount(2);
    await date.fill('2024-12-31'); await compare.click();
    await expect(results).toContainText('Terms as of 2024-12-31');
    await expect(results).toContainText('$31.00');
    await expect(compare).toBeFocused();
    await date.fill('2024-06-01'); await compare.click();
    await expect(results).toContainText('Loading comparable terms');
    await date.fill('2025-01-01'); await compare.click();
    await expect(results).toContainText('Terms as of 2025-01-01');
    await expect(root.locator('tbody tr')).toHaveCount(1);
    await expect(results).toContainText('$39.00');
    await expect(results).not.toContainText('$31.00');
    await page.evaluate(() => window.marketPending.forEach(resolve => resolve()));
    await expect(results).toContainText('Terms as of 2025-01-01');
    expect(await page.evaluate(() => window.marketRequests.at(-1).as_of)).toBe('2025-01-01');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await date.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await date.scrollIntoViewIfNeeded();
    await page.screenshot({path:`.github/pr-evidence/WR39.S6.J21/as-of-${width}-${theme}.png`,fullPage:true});
    await date.fill(''); await compare.click();
    await expect(results).toContainText('All recorded history');
    await expect(root.locator('tbody tr')).toHaveCount(2);
    expect(await page.evaluate(() => 'as_of' in window.marketRequests.at(-1))).toBe(false);
    await date.fill('2023-01-01'); await compare.click();
    await expect(results).toContainText('No comparable terms');
    await expect(results).toContainText('Terms as of 2023-01-01');
    await date.fill('2022-01-01'); await compare.click();
    await expect(results).toContainText('Could not load comparable terms');
    await expect(root.locator('tbody tr')).toHaveCount(0);
    await date.fill('2021-01-01'); await compare.click();
    await expect(results).toContainText('unavailable until the server update');
    await date.fill('2025-01-01'); await compare.click();
    await expect(results).toContainText('$39.00');
    await date.fill('2020-01-01'); await compare.click();
    await expect(root.locator('tbody tr')).toHaveCount(0);
    await expect(compare).toBeFocused();
    expect(await page.evaluate(() => window.marketRequests.length)).toBe(10);
  });
}
