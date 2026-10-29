import { expect } from 'e2e';
import { reproTest } from '../support.mjs';

const test = reproTest();
test('QA-025 Atlas stops reporting Updating after a terminal read failure', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await browser.route(`${new URL(app.baseUrl).origin}/api/v1/atlas-graph**`, route => route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } }));
  await app.open('/control-room?tab=system-map');
  await expect(browser.locator('#atlasState')).toContainText('System map temporarily unavailable');
  await screen.getByRole('button', 'Refresh', { exact: true }).tap();
  await expect(browser.locator('#atlasState')).toContainText('System map temporarily unavailable');
  await expect(browser.locator('#atlasOrb')).toHaveAttribute('data-state', 'urgent');
  await expect(browser.locator('#atlasState')).not.toContainText('Updating');
});
