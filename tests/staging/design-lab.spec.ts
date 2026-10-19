import { test, expect } from '@playwright/test';

test('Design Lab switches all sections and previews data states', async ({ page }) => {
  await page.goto('/design-lab');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  for (const name of ['Components', 'Rules', 'Tokens', 'States']) {
    const tab = page.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
  for (const state of ['empty', 'offline', 'refused', 'conflict', 'unknown', 'stale']) {
    await page.locator('#statePicker button[data-state=' + state + ']').click();
    await expect(page.locator('#stateDemo')).toHaveAttribute('data-state', state);
  }
});
