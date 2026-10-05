import { expect } from 'e2e';
import { reproTest } from '../support.mjs';

const test = reproTest();
test('QA-024 Control Room keyboard section selection updates its shareable route', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/control-room?tab=automations');
  const automations = screen.getByRole('tab', 'Automations', { exact: true });
  await expect(automations).toHaveAttribute('aria-selected', 'true');
  await automations.focus();
  await automations.press('ArrowRight');
  await expect(screen.getByRole('tab', 'Action Items', { exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(screen.getByRole('tabpanel', 'Action Items', { exact: true })).toBeVisible();
  await expect(browser).toHaveURL('/control-room?tab=attention');
});
