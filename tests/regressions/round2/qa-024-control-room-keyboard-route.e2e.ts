import { expect } from 'e2e';
import { reproTest } from '../support.mjs';

const test = reproTest();
test('QA-024 Control Room keyboard section selection updates its shareable route', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/control-room?tab=triage');
  const triage = screen.getByRole('tab', 'Triage', { exact: true });
  await expect(triage).toHaveAttribute('aria-selected', 'true');
  await triage.focus();
  await triage.press('ArrowDown');
  await expect(screen.getByRole('tab', 'Queue', { exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(screen.getByRole('tabpanel', 'Queue', { exact: true })).toBeVisible();
  await expect(browser).toHaveURL('/control-room?tab=queue');
  await app.open('/control-room?tab=attention');
  await expect(screen.getByRole('tab', 'Views', { exact: true })).toHaveAttribute('aria-selected', 'true');
  await app.open('/control-room');
  await screen.getByRole('tab', 'Automations', { exact: true }).tap();
  await browser.back();
  await expect(browser).toHaveURL('/control-room');
  await expect(screen.getByRole('tab', 'Queue', { exact: true })).toHaveAttribute('aria-selected', 'true');
  await browser.forward();
  await expect(browser).toHaveURL('/control-room?tab=automations');
  await expect(screen.getByRole('tab', 'Automations', { exact: true })).toHaveAttribute('aria-selected', 'true');
});
