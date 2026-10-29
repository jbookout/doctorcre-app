import { test, expect } from '@playwright/test';
import { routeLeads } from '../../test/leads-browser-fixture.mjs';
import { workspace, lead } from '../../test/leads-workspace-fixture.mjs';
import { mkdir } from 'node:fs/promises';

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`place chooser at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem('dealroom-theme', theme === 'dark' ? 'night' : 'light'), theme);
    await routeLeads(page, { getBoard: () => ({ ...workspace(), leads: Array.from({ length: 6 }, (_, i) => lead(i + 1)) }) });
    await page.route('**/maplibre-gl.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
      export * from './maplibre-gl.mjs?provider';
      import { Map as ProviderMap } from './maplibre-gl.mjs?provider';
      export class Map extends ProviderMap {
        constructor(options) { super(options); globalThis.leadsRenderer = this; }
      }
    ` }));
    await page.goto('http://localhost/leads');
    await page.getByRole('button', { name: 'Show territory', exact: true }).click();
    const marker = page.locator('.market-marker');
    await marker.waitFor();
    await page.evaluate(() => leadsRenderer.jumpTo({ center: [-87.2, 30.42], zoom: 11 }));
    await marker.click();
    const chooser = page.getByRole('region', { name: 'Leads in this place', exact: true });
    await expect(chooser).toBeVisible();
    if (width === 390) {
      const visibleRows = await chooser.locator('[data-map-lead]').evaluateAll(rows => rows.filter(row => {
        const rect = row.getBoundingClientRect();
        const list = row.parentElement.getBoundingClientRect();
        return rect.top >= list.top && rect.bottom <= list.bottom;
      }).length);
      expect(visibleRows, 'fully visible member rows').toBeGreaterThanOrEqual(4);
      expect(await marker.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === node;
      }), 'selected place marker is unobscured').toBe(true);
    }
    await mkdir('out/test-artifacts/place-chooser', { recursive: true });
    await page.locator('.territory').screenshot({ path: `out/test-artifacts/place-chooser/${width}-${theme}.png` });
  });
}
