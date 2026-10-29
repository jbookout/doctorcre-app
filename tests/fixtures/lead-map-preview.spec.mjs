import { test, expect } from '@playwright/test';
import { routeLeads } from '../../test/leads-browser-fixture.mjs';
import { workspace, lead } from '../../test/leads-workspace-fixture.mjs';

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`map preview follows hover and focus at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await routeLeads(page, { getBoard: () => ({ ...workspace(), leads: [lead(1), lead(2)] }) });
    await page.goto('http://localhost/leads');
    await page.getByRole('button', { name: 'Show territory', exact: true }).click();
    const marker = page.locator('.market-marker');
    await marker.hover();
    const preview = page.getByRole('tooltip');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('2 leads');
    await expect(preview).toContainText('Pensacola, FL');
    await expect(preview).toContainText('Market area only');
    await expect(preview).toContainText('Dr. Example 1');
    await expect(preview).toContainText('Dr. Example 2');
    await expect(page.locator('#leadDetail')).toBeHidden();
    await expect(page.locator('#marketFilter')).toHaveValue('');
    const box = await preview.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await preview.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`preview-${width}-${theme}.png`), animations: 'disabled' });
    await page.locator('h1').hover();
    await expect(preview).toBeHidden();
    await marker.focus();
    await expect(preview).toBeVisible();
    await expect(marker).toHaveAttribute('aria-describedby', await preview.getAttribute('id'));
    await page.keyboard.press('Escape');
    await expect(preview).toBeHidden();
    await expect(marker).toBeFocused();
    await page.keyboard.press('Enter');
    const chooser = page.getByRole('region', { name: 'Leads in this place', exact: true });
    await expect(chooser).toBeVisible();
    await expect(preview).toBeHidden();
    await chooser.getByRole('button', { name: 'Dr. Example 2', exact: true }).click();
    await expect(page.locator('#detailTitle')).toHaveText('Dr. Example 2');
    await page.getByRole('button', { name: 'Close lead details', exact: true }).click();
    await expect(chooser.getByRole('button', { name: 'Dr. Example 2', exact: true })).toBeFocused();
  });
}
