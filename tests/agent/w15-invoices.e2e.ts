import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Local only: needs the configured named Model Room desk. CI runs tests/journeys instead.
test('W15 agent records a payment on an unpaid invoice', async ({ app, agent, browser }) => {
  await app.open('/invoices');

  await agent.act('open the unpaid invoice for "Demo Harbor Renewal" and mark it paid today');
  await expect(browser.locator('#invoiceDetailFacts')).toContainText('Paid');
  await agent.assert('the Demo Harbor Renewal invoice shows as Paid');
});
