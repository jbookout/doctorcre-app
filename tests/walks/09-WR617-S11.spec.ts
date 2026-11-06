import { expect } from '@playwright/test';
import { test } from './privacy';
import { home, needs, visible } from './ui';

test("09 WR617.S11", async ({ page }) => {
  await home(page);
  for (const kind of ['Deal', 'Contact']) {
    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: 'Quick switcher', exact: true });
    await visible(dialog);
    await dialog.getByRole('combobox').fill('TEST');
    await expect.poll(() => dialog.getByRole('status').innerText().then(text => !/Loading/.test(text))).toBe(true);
    const candidates = dialog.getByRole('option').filter({ has: page.locator('small').filter({ hasText: new RegExp(`^${kind}$`) }) });
    needs(!await candidates.count(), `accessible TEST ${kind.toLowerCase()} in Quick switcher`);
    const optionId = await candidates.first().getAttribute('id');
    const input = dialog.getByRole('combobox');
    for (let n = 0; n < 100 && await input.getAttribute('aria-activedescendant') !== optionId; n++) await input.press('ArrowDown');
    expect(await input.getAttribute('aria-activedescendant') === optionId).toBe(true);
    await input.press('Enter');
    await page.waitForLoadState('domcontentloaded');
    expect(new URL(page.url()).pathname === (kind === 'Deal' ? '/deals' : '/relationships')).toBe(true);
    await page.keyboard.press('ControlOrMeta+k');
    await visible(page.getByRole('dialog', { name: 'Quick switcher', exact: true }));
    await page.keyboard.press('Escape');
  }
  await page.context().clearCookies();
  await page.reload();
  expect(await page.locator('[data-quick-switcher] [role="option"]').count()).toBe(0);
});
