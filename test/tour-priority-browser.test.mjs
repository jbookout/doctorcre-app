import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { detail, tourId } from './fixtures/tour-day.synthetic.mjs';
import { receipt } from './fixtures/tour-map.synthetic.mjs';

for (const width of [390, 1280]) for (const theme of ['dark', 'light']) {
  test(`Tour day reserves capture space and restores a visible stop at ${width}px ${theme}`, async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const fixture = structuredClone(detail), route = fixture.routes[0];
    Object.assign(fixture, { projection_id: 'synthetic-parity-v1', canonical_dataset_version: 'synthetic-v1', component_registry_version: 'map-v1' });
    route.stops.forEach((stop, index) => { stop.locked_appointment = false; stop.route_label = String(index + 1); });
    Object.assign(fixture, { route_version_id: route.id, route_version_state: 'accepted', accepted_route_version: 1, stops: route.stops });
    fixture.map_promotion_receipt = { ...structuredClone(receipt), tour_id: fixture.id, route_version_id: route.id, route_version: 1, projection_id: fixture.projection_id };
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('**/api/**', r => {
      const path = new URL(r.request().url()).pathname;
      return r.fulfill({ json: path === '/api/tours/detail' ? { data: fixture }
        : path === '/api/tours/library' ? { data: { tours: [{ id: tourId, name: fixture.name, status: 'scheduled' }] } }
        : path === '/api/system-work/session' ? { actor: { slug: 'joe' }, csrf_token: 'synthetic-only' } : {} });
    });
    const shot = async name => {
      if (!process.env.UI_SCREENSHOT_DIR) return;
      await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/${name}-${width}-${theme}.png`, fullPage: true });
      await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/${name}-${width}-${theme}-viewport.png` });
    };
    await page.goto(`${server.origin}/tours/day.html?tour=${tourId}`);
    await page.locator('.day-stop').nth(1).waitFor();
    await shot('day');
    assert.equal(await page.locator('#day-current a.primary').count(), 1, 'current stop has one primary navigation action');
    assert.equal(await page.locator('#day-current a.primary').innerText(), 'Navigate');
    assert.match(await page.locator('#day-current a.primary').getAttribute('href'), /google\.com/);
    assert.equal(await page.locator('#day-current a[href*="apple"]').innerText(), 'Apple Maps', 'alternate provider stays secondary');
    if (width === 1280) assert.ok((await page.locator('.stop-panel').boundingBox()).width >= 400, 'Tour day uses the freed desktop workspace width');
    await page.locator('#day-next').click();
    await page.reload(); await page.locator('.day-stop[aria-current="step"]').waitFor();
    await shot('return');
    const geometry = await page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect();
      return { contentBottom: box('.day-grid').bottom, dockTop: box('.capture-dock').top,
        headingTop: box('#day-current h2').top, headerBottom: box('.app-layout-tabbar').bottom };
    });
    assert.ok(geometry.contentBottom <= geometry.dockTop, `capture has its own space: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.headingTop >= geometry.headerBottom, `returned stop clears header: ${JSON.stringify(geometry)}`);
    const navigation = page.locator('#day-current a[href*="maps"]').first();
    assert.equal(await navigation.isVisible(), true);
    assert.match(await navigation.innerText(), /Navigate/);
    assert.ok(await navigation.evaluate(node => node.getBoundingClientRect().top < document.querySelector('#day-current .property-facts').getBoundingClientRect().top), 'navigation precedes supporting facts');
    await page.locator('#day-notes').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#day-notes').evaluate(node => {
      const box = node.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return node.contains(hit);
    }), true, 'Notes remains uncovered when scrolled into view');
    await page.goto(`${server.origin}/tours/route-editor.html?tour=${tourId}`);
    await page.locator('[data-itinerary-stop]').nth(1).waitFor();
    await shot('itinerary');
    assert.equal(await page.locator('#appSidebarToggle').getAttribute('aria-expanded'), 'false', 'itinerary starts with the Tour library collapsed');
    assert.equal(await page.locator('#appTodayToggle').getAttribute('aria-expanded'), 'false', 'itinerary starts with Today collapsed');
    if (width === 1280) assert.ok((await page.locator('#tour-detail').boundingBox()).width > 1000, 'itinerary owns the desktop workspace');
    assert.equal(await page.locator('#accepted-itinerary').getByText(route.stops[0].property_address, { exact: true }).count(), 1, 'each stop address appears once');
    assert.equal(await page.locator('[data-itinerary-stop][aria-current="step"] [data-itinerary-card]').count(), 1, 'selected facts live in the ordered stop');
    assert.equal(await page.locator('#accepted-itinerary canvas').count(), 0, 'unconfigured basemap uses a compact list fallback');
    const navigateTour = page.getByRole('link', { name: 'Navigate tour', exact: true });
    assert.equal(await navigateTour.count(), 1, 'accepted itinerary offers its Tour day action');
    assert.ok(await navigateTour.evaluate(node => node.getBoundingClientRect().bottom < 700), 'Navigate tour is on the first phone screen');
    assert.equal(await page.locator('#internal-cheat-sheet').getAttribute('open'), null, 'internal notes start collapsed on an accepted itinerary');
    assert.equal(await page.locator('#property-evidence-panel').getAttribute('open'), null, 'property evidence starts collapsed on an accepted itinerary');
    assert.equal(await page.locator('#route-editing').getAttribute('open'), null, 'route editing is collapsed for the accepted itinerary');
    assert.match(await page.locator('#accepted-itinerary [data-map-status]').innerText(), /Street map unavailable/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
}
