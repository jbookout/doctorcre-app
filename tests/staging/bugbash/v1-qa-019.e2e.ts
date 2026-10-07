import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief, stubJson } from '../v1/_h.ts';

// QA-019: with the client list unavailable, Review packet draft must keep the load-failure explanation, not ask for an impossible pick.
test('QA-019 Review packet keeps the client-load failure explanation', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await stubJson(browser, '**/api/v1/business/clients?scope=*', { error: 'INTERNAL_ERROR' }, 503);
  await app.open('/tours');
  await dismissBrief(screen);
  await screen.getByRole('button', 'Refresh tours').tap();
  await expect(screen.getByText('Clients temporarily unavailable.', { exact: true }).first()).toBeVisible();
  await screen.getByLabel('Tour name').fill('QA recheck tour');
  await screen.getByLabel('Tour notes').fill('QA recheck notes');
  await screen.getByRole('button', 'Review packet draft').tap();
  const message = () => browser.evaluate(() => document.getElementById('plan-message')?.textContent?.trim() ?? '');
  await expect.poll(message, { message: 'plan message after Review packet draft' }).not.toBe('');
  expect(await message(), 'plan message after Review packet draft').toContain('temporarily unavailable');
});
