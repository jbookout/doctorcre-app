import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Local only: needs the configured named Model Room desk. CI runs tests/journeys instead.
test('W2 agent opens the first deal that needs attention from Home', async ({ app, agent, browser }) => {
  await app.open('/');

  await agent.act('open the deal "Demo Dental North" from the deals that need attention');
  await expect(browser.locator('#panelTitle')).toContainText('Demo Dental North');
  await agent.assert('a deal detail popup for Demo Dental North is open and shows its next step');
});
