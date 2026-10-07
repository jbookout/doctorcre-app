import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { mkdirSync, writeFileSync } from 'node:fs';
import { screens } from '../../scripts/e2e-staging/screens.mjs';

// Deterministic reach check for every routed screen, on both targets (desktop
// and phone viewports per `docs/viewports.mdx`): 30 routes x 2 targets = the 60
// screens. Each records how many visible controls it renders, the
// denominator for "controls exercised vs present" in the coverage table.
const all = await screens();

describe('every screen opens signed in', { session: 'staging-partner', tags: ['screens'] }, () => {
  for (const screen of all) {
    test(`${screen.name} (${screen.path})`, async ({ app, browser, screen: ui, platform }) => {
      await app.open(screen.path);
      await expect(browser).not.toHaveURL(/\/auth\//);
      await expect(ui.getByText('DoctorCRE is temporarily unavailable')).toBeHidden();
      await expect(ui.getByRole('main').first()).toBeVisible();
      const controls = await browser.evaluate(() => {
        const visible = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        const nodes = [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [role=tab], [role=switch], [role=menuitem], summary')].filter(visible);
        return { count: nodes.length, names: nodes.slice(0, 400).map(el => (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 80)) };
      });
      const width = await browser.evaluate(() => window.innerWidth);
      mkdirSync('.e2e/staging-coverage', { recursive: true });
      writeFileSync(`.e2e/staging-coverage/screen-${width}-${screen.path.replace(/[^a-z0-9]+/gi, '_')}.json`, JSON.stringify({ path: screen.path, name: screen.name, surface: screen.surface, width, platform, ...controls }, null, 2));
      expect(controls.count).toBeGreaterThan(0);
    });
  }
});
