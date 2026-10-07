import { expect } from 'e2e';
import { test, rpc, seedFixture, baseUrl, Board, Identity, Viewers, QA_NAMESPACE } from './support.ts';

for (const viewer of Viewers) {
  test(`${viewer} Home Just Me uses authenticated ownership and restart preserves identity`, {session:viewer}, async ({ app, browser, api, screen }) => {
    const seeded=await seedFixture(baseUrl(app),`${QA_NAMESPACE}-home-${viewer}`,viewer,'realistic',true);
    await browser.setCookies([seeded.cookie]);
    const board=Board.parse((await rpc(api,'deal-room-board')).payload);
    await app.open('/?mode=live');
    await expect(screen.getByRole('button','Just Me')).toBeVisible();
    await expect(browser.locator('#dealCounts')).toContainText(`Active Deals: ${board.deals.length}`);
    await screen.getByRole('button','Just Me').tap();
    await expect(browser.locator('#dealCounts')).toContainText(`Active Deals: ${board.deals.filter(row=>row.owner===viewer).length}`);
    const owned=board.deals.find(row=>row.owner===viewer&&row.attention);
    const partner=board.deals.find(row=>row.owner!==viewer&&row.attention);
    if (!owned || !partner) throw new Error('This scoping test requires flagged deals owned by both partners');
    await expect(browser.locator('#dealFlags')).toContainText(owned.name);
    await expect(browser.locator('#dealFlags')).not.toContainText(partner.name);
    await app.screenshot(`${viewer}-just-me`);
    await app.restart();
    expect(Identity.parse(await (await api('/api/test/identity')).json()).viewer).toBe(viewer);
    await app.open('/?mode=live');
    await expect(browser.locator('#dealCounts')).toContainText(`Active Deals: ${board.deals.length}`);
  });
}

test.describe('a shared browser identity survives serial navigation', {serial:true,session:'dell'}, () => {
  test.beforeEach(async ({api})=>{expect(Identity.parse(await (await api('/api/test/identity')).json()).viewer).toBe('dell');});
  test('open the built leads workspace',async({app,browser})=>{await app.open('/leads?mode=live');await expect(browser.locator('.lead-card')).toHaveCount(14);});
  test('open invoices using the same synthetic session',async({app,browser})=>{await app.open('/invoices?mode=live');await expect(browser.locator('#invoiceRows')).toContainText('Demo Harbor Renewal');});
});
