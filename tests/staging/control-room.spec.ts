import { test, expect } from '@playwright/test';

// The V2 workbench: one section nav in the workspace sidebar, a list region and
// a collapsible detail column. Every section is visited by its new name.
const SECTIONS: [string, string][] = [
  ['Inbox', 'inbox'], ['Waiting on you', 'waiting'], ['Triage', 'triage'], ['Queue', 'queue'],
  ['Views', 'views'], ['Boards', 'boards'], ['Automations', 'automations'], ['Connections', 'connections'],
  ['Agents', 'agents'], ['System map', 'system-map'], ['Sessions', 'sessions'],
];

test('Control Room visits every workbench section and checks the available automation schedule', async ({ page }) => {
  await page.goto('/control-room');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  const nav = page.getByRole('tablist', { name: 'Control Room sections' });
  if (!(await nav.isVisible())) await page.locator('#appSidebarToggle').click();
  await expect(page.getByRole('tab', { name: 'Queue', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#crQueueCoverage')).not.toBeEmpty();
  for (const [name, key] of SECTIONS) {
    const tab = page.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = await tab.getAttribute('aria-controls');
    await expect(page.locator('#' + panel)).toBeVisible();
    await expect(page.locator('#' + panel)).not.toBeEmpty();
    await expect(page).toHaveURL(new RegExp(`[?&]tab=${key}(?:&|$)`));
  }
  await page.getByRole('tab', { name: 'Automations', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#automationMonth')?.textContent?.trim());
  if (await page.locator('#automationControls').isHidden()) {
    await expect(page.locator('#automationState')).toBeVisible();
    await expect(page.locator('#automationState')).toHaveText(/Automations unavailable|No scheduled runs in /);
    await expect(page.locator('#automationCalendar')).toBeEmpty();
    return;
  }
  const month = await page.locator('#automationMonth').textContent();
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(page.locator('#automationMonth')).not.toHaveText(month || '');
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await expect(page.locator('#automationMonth')).toHaveText(month || '');
});

test('old Control Room tab links land on their new sections', async ({ page }) => {
  for (const [old, name] of [['overview', 'Boards'], ['attention', 'Views'], ['system-map', 'System map'], ['connections', 'Connections']]) {
    await page.goto(`/control-room?tab=${old}`);
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
  }
});

test('opening a Queue row shows that record in the detail pane', async ({ page }) => {
  await page.goto('/control-room?tab=queue');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  const row = page.locator('#crQueueList [role="option"]').first();
  await expect(row).toBeVisible();
  const ref = (await row.locator('.cr-row-ref').textContent())?.trim() || '';
  expect(ref).not.toBe('');
  await row.click();
  await expect(page.locator('#crWorkbench')).toHaveAttribute('data-detail', 'open');
  await expect(page.locator('#crDetail [data-detail-ref]')).toHaveText(ref);
});
