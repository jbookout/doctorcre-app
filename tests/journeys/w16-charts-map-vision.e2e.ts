import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { readFileSync } from 'node:fs';
import { workspace } from '../../test/leads-workspace-fixture.mjs';

const deals = JSON.parse(readFileSync(new URL('../../test/fixtures/charts-synthetic.json', import.meta.url), 'utf8'));
const noKey = !process.env.TYPESAFE_API_KEY;

async function serveFixtures(browser: any) {
  await browser.route('**/auth/session', (route: any) => route.fulfill({json:{actor:{slug:'dell'},csrf_token:'synthetic-e2e-token'}}));
  await browser.route('**/mcp', (route: any) => {
    const { name } = JSON.parse(route.request.postData ?? '{}').params;
    const body = name === 'deal-room-board' ? deals : name === 'lead-board' ? workspace() : { ok: true };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(body) }] } } });
  });
  await browser.route('**/api/**', (route: any) => route.fulfill({ json: { actor: { slug: 'dell' }, csrf_token: 'synthetic-e2e-token', items: [], counts: {} } }));
}

// W16: the By phase bars are drawn paint beside their table, so only the screenshot shows their lengths.
test('W16 the By phase chart draws its bars in proportion to the board', async ({ app, browser, agent }) => {
  test.skip(noKey, 'TYPESAFE_API_KEY is not set');
  await serveFixtures(browser);
  await app.open('/?view=charts&mode=live');
  await expect(browser.locator('#chartPhase tbody tr').first()).toBeVisible();
  // Below 480px the stylesheet hides the bars and the table alone carries the counts.
  test.skip(await browser.evaluate(() => innerWidth < 480), 'the phone view draws no bars');
  await browser.evaluate(() => document.querySelector('#chartPhase')?.scrollIntoView({ block: 'center' }));
  await agent.assert(
    'In the By phase chart, the Prospective Client bar is the longest and the Research bar is about half as long. The Site Selection and Closing bars are the shortest, each only a small dot.',
    { vision: 'only' },
  );
});

// W16: the territory pins are DOM markers over a canvas map, so the screenshot shows where they sit.
test('W16 the territory map pins every lead market on the Gulf Coast', async ({ app, browser, agent }) => {
  test.skip(noKey, 'TYPESAFE_API_KEY is not set');
  await serveFixtures(browser);
  await app.open('/leads?mode=live');
  await browser.locator('#showTerritory').tap();
  await expect(browser.locator('.market-marker')).toHaveCount(2);
  await expect(browser.getByRole('button', { name: 'Mobile, AL: 1 leads', exact: true })).toHaveText('1');
  const coastalMarker = browser.locator('.market-marker').filter({ hasText: '13' });
  await expect(coastalMarker).toHaveCount(1);
  await expect(coastalMarker).toHaveAttribute('aria-label', /Pensacola, FL: 12/);
  await expect(coastalMarker).toHaveAttribute('aria-label', /Gulf Breeze, FL: 1/);
  await browser.evaluate(() => document.querySelector('#territoryMap')?.scrollIntoView({ block: 'center' }));
  await agent.assert(
    'Inside the Territory map rectangle, exactly two round count markers labelled 1 and 13 are visible along the coastline. There are no other map pins. The market-name pills and Stage filter outside this rectangle are not map pins.',
    { vision: 'only' },
  );
});
