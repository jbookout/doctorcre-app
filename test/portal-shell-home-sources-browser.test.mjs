import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
const fixture = JSON.parse(await readFile(new URL('./fixtures/portal/example-health.market-study.json', import.meta.url)));

async function open(t, width = 390, theme = 'light', mapAvailable = false, publication = fixture, moduleRoutes = []) {
  const server = await startFixtureServer(); t.after(server.stop);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  if (!mapAvailable) await page.route('**/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs', route => route.abort());
  else await page.route('**/portal/files/*', route => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
  for (const item of publication.developments) {
    await page.route(`**/portal/files/${item.image.asset.sha256}`, route => route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#657887"/><text x="32" y="210" fill="white" font-size="28">Synthetic development preview</text></svg>',
      }));
  }
  await page.goto(`${server.url}/portal/index.html`);
  await page.evaluate(async ({ fixture, theme, moduleRoutes }) => {
    document.documentElement.dataset.theme = theme;
    const { mountPortal } = await import('/js/ui-portal.js');
    window.portalPanel = mountPortal(document.querySelector('#portal-root'), { load: async () => fixture, modules: moduleRoutes.map(route => ({ route, label: route, available: () => true, render: () => `${route} content` })) });
  }, { fixture: publication, theme, moduleRoutes });
  return page;
}

test('Home and Sources keep readable cards and touch navigation at both widths and themes', async t => {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    await t.test(`${width} ${theme}`, async t => {
      const publication = structuredClone(fixture);
      publication.properties = Array.from({ length: 4 }, (_, index) => ({
        ...fixture.properties[0], id: `sample-${index}`, address: `Example address ${index + 1}`,
      }));
      const page = await open(t, width, theme, false, publication);
      await page.locator('.portal-hero').waitFor();
      const previews = page.locator('.portal-directory article img');
      assert.equal(await previews.count(), fixture.developments.length);
      assert.equal(await previews.first().getAttribute('alt'), fixture.developments[0].image.alt);
      assert.equal(await previews.first().evaluate(node => getComputedStyle(node).objectFit), 'cover');
      await previews.first().scrollIntoViewIfNeeded();
      await previews.first().evaluate(node => node.decode());
      for (const link of await page.locator('.portal-header nav a').all()) {
        assert.ok((await link.boundingBox()).height >= 44);
      }
      assert.equal(await page.locator('.portal-hero > p').last().evaluate(node => node.getBoundingClientRect().width <= 720), true);
      await page.getByRole('navigation').getByRole('link', { name: 'Sources', exact: true }).click();
      await page.getByRole('heading', { name: 'Sources', exact: true }).waitFor();
      const cards = page.locator('.portal-source-list article');
      assert.equal(await cards.count(), publication.properties.length);
      assert.equal(await cards.evaluateAll(nodes => nodes.slice(1).every((node, index) => {
        const box = node.getBoundingClientRect();
        const previous = nodes[index].getBoundingClientRect();
        return box.top >= previous.bottom + 12 || box.left >= previous.right + 12;
      })), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mkdir('out/test-artifacts/portal-shell', { recursive: true });
      await page.evaluate(() => { scrollTo(0, 0); document.activeElement?.blur(); });
      await page.screenshot({ path: `out/test-artifacts/portal-shell/sources-${width}-${theme}.png`, fullPage: true });
    });
  }
});

test('scroll progress and sticky title track document and header geometry', async t => {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    await t.test(`${width} ${theme}`, async t => {
      const page = await open(t, width, theme);
      await page.getByRole('heading', { name: fixture.market.home_title, exact: true }).waitFor();
      await page.locator('.scroll-progress').waitFor({ state: 'attached' });
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--scroll-progress').trim() === '0');
      await page.evaluate(() => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2));
      await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scroll-progress')) - .5) < .02);
      await page.evaluate(() => { document.querySelector('header').style.paddingBottom = '100px'; });
      await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--site-header-height')) - document.querySelector('header').getBoundingClientRect().height) < 1);
      assert.equal(await page.locator('h1').evaluate(node => Math.abs(parseFloat(getComputedStyle(node).top) - document.querySelector('header').getBoundingClientRect().height) < .01), true);
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--scroll-progress').trim() === '1');
      await page.getByRole('navigation').getByRole('link', { name: 'Sources', exact: true }).click();
      await page.getByRole('heading', { name: 'Sources', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => { document.querySelector('main').style.minHeight = '4000px'; scrollTo(0, 500); });
      await page.waitForFunction(() => {
        const expected = scrollY / (document.documentElement.scrollHeight - innerHeight);
        return Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scroll-progress')) - expected) < .001;
      });
      await page.evaluate(() => { document.querySelector('main').replaceChildren(); document.querySelector('main').style.minHeight = '0'; scrollTo(0, 0); });
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--scroll-progress').trim() === '0');
      await page.evaluate(() => { window.portalPanel.dispose(); });
      assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--scroll-progress')), '');
      assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--site-header-height')), '');
      await page.evaluate(() => dispatchEvent(new Event('resize')));
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--site-header-height')), '');
    });
  }
});

test('colliding context labels have stems ending at visible centres after map resize', async t => {
  const publication = structuredClone(fixture);
  const locator = publication.developments[0].locator;
  for (const development of publication.developments) development.locator = locator;
  for (const anchor of publication.context_anchors) anchor.locator = locator;
  publication.client.current_practice.locator = locator;
  for (const width of [390, 1280]) {
    await t.test(String(width), async t => {
      const page = await open(t, width, 'light', true, publication);
      await page.locator('.pin-stem').first().waitFor({ state: 'attached' });
      const validGeometry = () => {
        const map = document.querySelector('.portal-map > div').getBoundingClientRect();
        const labels = [...document.querySelectorAll('.portal-marker')].map(node => node.getBoundingClientRect());
        const stems = [...document.querySelectorAll('.pin-stem')];
        return labels.length > 2 && labels.every((box, i) => {
          const stem = stems[i];
          return Math.abs(Number(stem.getAttribute('x2')) - (box.x + box.width / 2 - map.x)) < 2 &&
            Math.abs(Number(stem.getAttribute('y2')) - (box.y + box.height / 2 - map.y)) < 2 &&
            box.x >= map.x - 1 && box.right <= map.right + 1 &&
            labels.slice(0, i).every(other => box.right <= other.x || other.right <= box.x || box.bottom <= other.y || other.bottom <= box.y);
        });
      };
      await page.waitForFunction(validGeometry);
      await page.setViewportSize({ width: width + 80, height: 900 });
      await page.waitForFunction(validGeometry);
      await page.locator('.portal-marker').first().click();
      await page.getByRole('dialog').waitFor();
    });
  }
});

test('synthetic shell supports keyboard, history, dialogs and expiry on phone and desktop in both themes', async t => {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    await t.test(`${width} ${theme}`, async t => {
      const page = await open(t, width, theme);
      const home = page.getByRole('heading', { name: fixture.market.home_title, exact: true });
      await home.waitFor();
      assert.equal(await home.evaluate(node => node === document.activeElement), true);
      assert.equal(await page.getByRole('status').innerText(), 'Map unavailable. Explore the development and regional context cards below.');
      await page.getByRole('button', { name: 'Explore Example Town Center', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('dialog').waitFor();
      assert.match(await page.getByRole('dialog').innerText(), /Concept plan only|Approximate study locator|Planning agenda/);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', { name: 'Explore Example Town Center', exact: true }).evaluate(node => node === document.activeElement), true);
      await page.getByRole('button', { name: 'Explore Example Regional Hospital', exact: true }).click();
      assert.match(await page.getByRole('dialog').innerText(), /Example Avenue/);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'Explore current practice', exact: true }).click();
      assert.match(await page.getByRole('dialog').innerText(), /About 2,000 SF today/);
      await page.getByRole('link', { name: 'Practice website', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('navigation').getByRole('link', { name: 'Sources', exact: true }).focus();
      await page.keyboard.press('Enter');
      const sources = page.getByRole('heading', { name: 'Sources', exact: true });
      await sources.waitFor();
      assert.equal(await sources.evaluate(node => node === document.activeElement), true);
      assert.match(await page.locator('main').innerText(), /Every figure in this synthetic study is invented/);
      assert.equal(await page.locator('nav [aria-current=page]').innerText(), 'Sources');
      await page.goBack(); await home.waitFor();
      await page.goForward(); await sources.waitFor();
      await page.evaluate(() => { location.hash = '#unknown'; });
      await page.getByRole('heading', { name: 'Page unavailable' }).waitFor();
      await page.getByRole('link', { name: 'Return Home', exact: true }).click();
      await home.waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mkdir('out/test-artifacts/portal-shell', { recursive: true });
      await page.screenshot({ path: `out/test-artifacts/portal-shell/${width}-${theme}.png`, fullPage: true });
      await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
      assert.match(await page.locator('#portal-root').innerText(), /session expired/);
      assert.equal(await page.locator('main, dialog').count(), 0);
      await page.evaluate(() => { location.hash = '#sources'; });
      assert.doesNotMatch(await page.locator('body').innerText(), /Every figure|Sample County/);
    });
  }
});

test('self-hosted local-layer map opens the development with no navigation handoff', async t => {
  const page = await open(t, 1280, 'light', true);
  const marker = page.locator('.portal-map').getByRole('button', { name: '1. Example Town Center', exact: true });
  await marker.waitFor();
  await page.locator('.portal-map').getByRole('button', { name: 'Example Regional Hospital', exact: true }).waitFor();
  await page.locator('.portal-map').getByRole('button', { name: 'C. Current practice', exact: true }).waitFor();
  await marker.focus();
  await page.locator('.portal-marker-preview').getByText('A mixed-use center.', { exact: true }).waitFor();
  await marker.click();
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /Adds rooftops near the study area/);
  assert.equal(await page.locator('a[href*="maps.google"], a[href*="maps.apple"]').count(), 0);
  await page.getByRole('dialog').getByRole('link', { name: 'View primary source', exact: true }).click();
  await page.getByRole('heading', { name: 'Sources', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
});


test('citations, independent context and registered routes work at both widths and themes', async t => {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    for (const empty of [false, true]) await t.test(`${width} ${theme} optional groups ${empty ? 'absent' : 'present'}`, async t => {
      const publication = structuredClone(fixture);
      if (empty) {
        publication.developments = [];
        delete publication.demographics.micro_zones;
        delete publication.demographics.competition;
      }
      const routes = ['documents', 'roadmap', 'local-context'];
      const page = await open(t, width, theme, true, publication, routes);
      await page.locator('.portal-marker').first().waitFor();
      assert.equal(await page.locator('.portal-map').count(), 1);
      assert.equal(await page.locator('.portal-marker').count(), publication.developments.filter(d => d.locator).length + publication.context_anchors.length + 1);
      assert.equal(await page.getByRole('heading', { name: 'Major development activity', exact: true }).count(), empty ? 0 : 1);
      await page.getByRole('navigation').getByRole('link', { name: 'Sources', exact: true }).click();
      await page.getByRole('heading', { name: 'Sources', exact: true }).waitFor();
      const hrefs = await page.locator('main a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
      for (const area of publication.demographics.age.geographies) assert.ok(hrefs.includes(area.source_url));
      for (const zone of publication.demographics.micro_zones?.zones ?? []) assert.ok(hrefs.includes(`files/${zone.study_pdf.sha256}`));
      for (const office of publication.demographics.competition?.offices ?? []) assert.ok(hrefs.includes(office.source_url));
      assert.equal(await page.getByRole('heading', { name: 'Radius reports', exact: true }).count(), empty ? 0 : 1);
      assert.equal(await page.getByRole('heading', { name: 'Competitor directory sources', exact: true }).count(), empty ? 0 : 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mkdir('out/test-artifacts/portal-shell', { recursive: true });
      await page.screenshot({ path: `out/test-artifacts/portal-shell/citations-${width}-${theme}-${empty}.png`, fullPage: true });
      for (const route of routes) {
        await page.getByRole('navigation').getByRole('link', { name: route, exact: true }).click();
        await page.getByRole('heading', { name: route, exact: true }).waitFor();
        assert.match(await page.locator('main').innerText(), new RegExp(`${route} content`));
      }
      await page.getByRole('navigation').getByRole('link', { name: 'Home', exact: true }).click();
      await page.locator('.portal-marker').first().waitFor();
      await page.screenshot({ path: `out/test-artifacts/portal-shell/context-${width}-${theme}-${empty}.png`, fullPage: true });
    });
  }
});
