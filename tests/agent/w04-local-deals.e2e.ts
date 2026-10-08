import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Local only: needs the configured named Model Room desk. CI runs tests/journeys instead.
test('W4 agent moves a Local Deals card into Legal', async ({ app, agent, browser }) => {
  await app.open('/deals');

  await agent.act('move the "Demo Specialty Clinic" card from Negotiating to the Legal column and confirm the move');
  await expect(browser.locator('[data-column="legal"] [data-id="d23"]')).toBeVisible();
  await agent.assert('Demo Specialty Clinic now appears in the Legal column of the board');
});
