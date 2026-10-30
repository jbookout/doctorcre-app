import { expect } from 'e2e';
import { reproTest } from '../support.mjs';

const test = reproTest();
test('QA-024 Control Room keyboard section selection updates its shareable route', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/control-room?tab=triage');
  const phone = await browser.evaluate(() => innerWidth < 760);
  const openNavigation = async () => {
    const toggle = browser.locator('#appSidebarToggle');
    if (phone && await toggle.getAttribute('aria-expanded') === 'false') await toggle.tap();
  };
  await openNavigation();
  const triage = screen.getByRole('tab', /^Triage(?: \d+)?$/);
  await expect(triage).toHaveAttribute('aria-selected', 'true');
  await triage.focus();
  await triage.press('ArrowDown');
  await openNavigation();
  await expect(screen.getByRole('tab', /^Queue(?: \d+)?$/)).toHaveAttribute('aria-selected', 'true');
  if (phone) await browser.locator('[data-layout-close="sidebar"]').tap();
  await expect(screen.getByRole('tabpanel', /^Queue(?: \d+)?$/)).toBeVisible();
  await expect(browser).toHaveURL('/control-room?tab=queue');
  await app.open('/control-room?tab=attention');
  await openNavigation();
  await expect(screen.getByRole('tab', /^Views(?: \d+)?$/)).toHaveAttribute('aria-selected', 'true');
  await app.open('/control-room');
  await openNavigation();
  await screen.getByRole('tab', 'Automations', { exact: true }).tap();
  await browser.back();
  await expect(browser).toHaveURL('/control-room');
  await openNavigation();
  await expect(screen.getByRole('tab', /^Queue(?: \d+)?$/)).toHaveAttribute('aria-selected', 'true');
  await browser.forward();
  await expect(browser).toHaveURL('/control-room?tab=automations');
  await openNavigation();
  await expect(screen.getByRole('tab', 'Automations', { exact: true })).toHaveAttribute('aria-selected', 'true');
});
