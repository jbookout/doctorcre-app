import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../../scripts/artifact.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
let output;

async function undersizedTargets(page, selectors) {
  const targets = await page.locator(selectors.join(', ')).evaluateAll(nodes => nodes
    .filter(node => node.getClientRects().length)
    .map(node => {
      const { width, height } = node.getBoundingClientRect();
      return { text: node.textContent.trim(), selector: node.id || node.className || node.tagName, width, height };
    }));
  return targets
    .filter(target => target.width < 44 || target.height < 44);
}

test.beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), 'doctorcre-card-floors-'));
  await buildArtifact({ root, outDir: output });
});
test.afterAll(async () => { await rm(output, { recursive: true, force: true }); });

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: 960 }, colorScheme: theme, reducedMotion: 'reduce' });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
      const seed = JSON.parse(await readFile(join(output, 'site/data/board-seed.json'), 'utf8'));
      Object.assign(seed.deals.find(deal => deal.id === 'd14'), {
        phase: 'Negotiation', operating_state: 'active',
        phase_started_on: { pending: '2026-08-10', research: '2026-08-31', negotiation: '2026-09-20' },
      });
      const vendors = ['lender', 'lender', 'landlord_rep'].map((role, index) => ({
        party_id: `demo-vendor-${index}`, role,
        company: { id: `demo-company-${index}`, name: `Demo company ${index}` },
        contact: { id: `demo-contact-${index}`, name: `Demo contact ${index}` },
      }));
      for (const outcome of ['won', 'lost']) seed.deals.push({
        ...seed.deals.find(deal => deal.id === 'd14'), id: `demo-${outcome}`,
        phase: 'Closed', outcome, closed_on: '2026-10-01', vendors,
      });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://localhost') return route.abort();
        if (url.pathname === '/data/board-seed.json') return route.fulfill({ json: seed });
        if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
        const path = url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
        try {
          return route.fulfill({ body: await readFile(join(output, 'site', path)),
            contentType: /\.m?js$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'text/html' });
        } catch { return route.fulfill({ status: 404, body: '' }); }
      });
      await page.goto('http://localhost/deals?deal=d14');
      await expect(page.locator('#detailPhase')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.evaluate(() => document.fonts.ready);
    });

    test('built deal Park controls meet the 44px touch floor', async ({ page }) => {
      const park = page.locator('.park-options > summary');
      const collapsed = await park.boundingBox();
      await park.click();
      const sizes = await page.locator('.park-options > summary, #detailParkForm input').evaluateAll(nodes => nodes.map(node => {
        const { width, height } = node.getBoundingClientRect();
        return { control: node.tagName, width, height };
      }));
      expect(sizes).toHaveLength(2);
      sizes.unshift({ control: 'Collapsed Park', width: collapsed.width, height: collapsed.height });
      expect(sizes.filter(size => size.width < 44 || size.height < 44), JSON.stringify(sizes)).toEqual([]);
    });

    test('built deal phase labels and dates meet the 13px text floor', async ({ page }) => {
      const labels = page.locator('.phase-rail li > span');
      const dates = page.locator('.phase-rail :is(time, small)');
      await expect(labels).toHaveCount(8);
      expect(await dates.count()).toBeGreaterThanOrEqual(3);
      const sizes = await labels.or(dates).evaluateAll(nodes => nodes.map(node => ({
        text: node.textContent, size: parseFloat(getComputedStyle(node).fontSize),
      })));
      expect(sizes.filter(item => item.size < 13), JSON.stringify(sizes)).toEqual([]);
    });

    test('built Closed and Lost vendor roles retain 16px separation', async ({ page }) => {
      await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
      for (const [view, outcome] of [['Closed deals', 'won'], ['Lost deals', 'lost']]) {
        await page.getByRole('button', { name: view, exact: true }).click();
        const card = page.locator(`#closedDealsList [data-id="demo-${outcome}"]`);
        await expect(card).toBeVisible();
        await expect(card.locator('.deal-vendor-group')).toHaveCount(2);
        const gaps = await card.locator('.deal-vendors').evaluate(node => {
          const groups = [...node.querySelectorAll('.deal-vendor-group')];
          const assignments = [...groups[0].querySelectorAll('li')];
          return {
            roles: groups[1].getBoundingClientRect().top - groups[0].getBoundingClientRect().bottom,
            assignments: assignments[1].getBoundingClientRect().top - assignments[0].getBoundingClientRect().bottom,
          };
        });
        expect(gaps.roles, `${view}: ${JSON.stringify(gaps)}`).toBeGreaterThanOrEqual(16);
        expect(gaps.roles).toBeGreaterThanOrEqual(2 * gaps.assignments);
      }
    });

    if (width === 1280) {
      test('built board controls meet the desktop 44px touch floor', async ({ page }) => {
        const small = await undersizedTargets(page, ['#boardChips [data-filter="all"]', '.card-open', '#appSyncRefresh', '#retryRead']);
        expect(small, JSON.stringify(small)).toEqual([]);
      });

      for (const [view, outcome] of [['Closed deals', 'won'], ['Lost deals', 'lost']]) {
        test(`built ${view.toLowerCase()} title controls meet the desktop 44px touch floor`, async ({ page }) => {
          await page.getByRole('button', { name: 'Back to deals', exact: true }).click();
          await page.getByRole('button', { name: view, exact: true }).click();
          await expect(page.locator(`#closedDealsList [data-id="demo-${outcome}"] .card-open`)).toBeVisible();
          const small = await undersizedTargets(page, ['.card-open', '#appSyncRefresh', '#retryRead']);
          expect(small, JSON.stringify(small)).toEqual([]);
        });
      }
    }
  });
}
