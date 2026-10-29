import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { routeLeads } from '../../test/leads-browser-fixture.mjs';

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`Leads has flat framing and reachable territory at ${width}px ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await routeLeads(page);
    await page.goto('http://localhost/leads');
    await page.locator('#leadBoard .lead-card').first().waitFor();
    const capture = async name => {
      if (!process.env.LEADS_DESIGN_DIR) return;
      await mkdir(process.env.LEADS_DESIGN_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.LEADS_DESIGN_DIR}/${width}-${theme}-${name}.png`, fullPage: true });
      await page.screenshot({ path: `${process.env.LEADS_DESIGN_DIR}/${width}-${theme}-${name}-viewport.png` });
    };
    await capture('leads');
    const framing = await page.locator('#leadBoard .stage-column .lead-card').evaluateAll(cards => cards.map(card => {
      const style = getComputedStyle(card);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].every(value => parseFloat(value) > 0);
    }));
    expect.soft(framing.some(Boolean), 'stage panels must not contain fully bordered cards').toBe(false);
    const accents = await page.locator('button, a').evaluateAll(nodes => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--accent)'; document.body.append(probe);
      const accent = getComputedStyle(probe).backgroundColor; probe.remove();
      return nodes.filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight && getComputedStyle(node).backgroundColor === accent;
      }).length;
    });
    expect.soft(accents, 'at most one visible primary action').toBeLessThanOrEqual(1);
    expect.soft(await page.locator('#hotLeads, .hot-row').count(), 'the board is the only ranked lead list').toBe(0);
    const entry = page.getByRole('link', { name: 'Territory', exact: true });
    expect.soft(await entry.count(), 'territory has an obvious in-page entry').toBe(1);
    if (await entry.count()) {
      const box = await entry.boundingBox();
      expect.soft(box.y).toBeGreaterThanOrEqual(0);
      expect.soft(box.y + box.height).toBeLessThanOrEqual(1000);
      await entry.click();
      const region = await page.locator('.territory').boundingBox();
      expect.soft(region.y).toBeGreaterThanOrEqual(0);
      expect.soft(region.y + 120, 'territory heading and reveal action enter the viewport').toBeLessThan(900);
    }
    await page.getByRole('button', { name: 'Show territory', exact: true }).click();
    await page.locator('.market-marker').first().waitFor();
    await page.locator('.territory').scrollIntoViewIfNeeded();
    await capture('territory');
    const targets = await page.locator('.market-marker, #marketCounts button').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect(); return { width: r.width, height: r.height };
    }));
    expect.soft(targets.length).toBeGreaterThan(0);
    expect.soft(targets.every(r => r.width >= 44 && r.height >= 44), 'map and market targets are at least 44px').toBe(true);
    expect.soft(await page.getByRole('button', { name: 'Territory shown', exact: true }).isVisible(), 'loaded map does not leave a disabled heading action').toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
