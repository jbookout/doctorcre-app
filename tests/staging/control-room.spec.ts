import { test, expect } from '@playwright/test';

test('Control Room switches every section and browses the automation calendar', async ({ page }) => {
  await page.goto('/control-room');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  for (const name of ['Connections', 'Automations', 'Action Items', 'Agents', 'System Map', 'Sessions', 'System Job Board']) {
    const tab = page.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = await tab.getAttribute('aria-controls');
    await expect(page.locator('#' + panel)).toBeVisible();
  }
  await page.getByRole('tab', { name: 'Automations', exact: true }).click();
  await expect(page.locator('#automationMonth')).not.toBeEmpty();
  const month = await page.locator('#automationMonth').textContent();
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(page.locator('#automationMonth')).not.toHaveText(month || '');
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await expect(page.locator('#automationMonth')).toHaveText(month || '');
});
