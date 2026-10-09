import { reproTest } from './support.mjs';
import { expect } from 'e2e';

const test = reproTest();
const viewports = [{ width: 1440, height: 960 }, { width: 390, height: 844 }];

async function preferenceGeometry(browser) {
  return browser.evaluate(() => {
    const control = document.querySelector('#deviceOptIn');
    const box = control.getBoundingClientRect();
    const tabs = document.querySelector('.app-layout-tabbar').getBoundingClientRect();
    return {
      controlTop: box.top, controlBottom: box.bottom, tabbarBottom: tabs.bottom, viewportHeight: innerHeight,
      clear: box.top >= tabs.bottom && box.bottom < innerHeight,
      uncovered: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === control,
    };
  });
}

for (const viewport of viewports) {
  test(`QA-010 notification preferences navigation brings controls into view at ${viewport.width}px`, { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
    await browser.setViewport(viewport);
    await app.open('/');
    await screen.getByRole('button', /account and settings/i).tap();
    await screen.getByRole('link', 'Notification preferences').tap();
    await expect(browser).toHaveURL('/updates#prefForm');
    await expect(screen.getByRole('heading', 'Your notification preferences')).toBeVisible();
    await expect(browser.locator('#prefSave')).toBeEnabled();
    // Enabling the fields precedes the next animation frame that anchors them.
    await expect.poll(async () => (await preferenceGeometry(browser)).clear).toBe(true);
    await expect.poll(async () => (await preferenceGeometry(browser)).uncovered).toBe(true);
    const form = await browser.locator('#prefForm').boundingBox();
    expect(form.y, JSON.stringify({ form, viewport })).toBeGreaterThanOrEqual(0);
    expect(form.y, JSON.stringify({ form, viewport })).toBeLessThan(viewport.height);
    await browser.locator('#deviceOptIn').focus();
    await expect(browser.locator('#deviceOptIn')).toBeFocused();
    await app.screenshot(`preferences-navigation-${viewport.width}`);
  });
}

for (const viewport of viewports) {
  for (const initialFailure of [false, true]) {
    test(`QA-010 preferences anchor once after first success at ${viewport.width}px (failure: ${initialFailure})`, { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser }) => {
      await browser.setViewport(viewport);
      if (initialFailure) {
        await browser.route('**/mcp', route => {
          const request = JSON.parse(route.request.postData || '{}');
          return request.params?.name === 'read-notification-preferences'
            ? route.fulfill({ status: 503, json: { ok: false, error: 'temporarily_unavailable' } })
            : route.continue();
        });
      }
      await app.open('/updates?mode=live#prefForm');
      await expect(browser.locator('#docMorningBrief')).toBeVisible();
      await browser.locator('#morningClose').tap();
      if (initialFailure) {
        await expect(browser.locator('#prefForm')).toBeHidden();
        await expect(browser.locator('#prefState')).toContainText(/unavailable|could not/i);
        await browser.unroute('**/mcp');
        await browser.locator('#appSyncRefresh').tap();
      }
      await expect(browser.locator('#deviceOptIn')).toBeEnabled();
      // Wait on geometry, including the actual first control under sticky tabs.
      await expect.poll(async () => (await preferenceGeometry(browser)).clear).toBe(true);
      await expect.poll(async () => (await preferenceGeometry(browser)).uncovered).toBe(true);
      // Anchoring scrolls without taking focus from the user's retry control.
      if (initialFailure) await expect(browser.locator('#appSyncRefresh')).toBeFocused();
      await app.screenshot(`preferences-anchor-${viewport.width}`);
      const observed = await browser.evaluate(async () => (await import('/js/notifications.js')).view.preference.observed_at);
      await browser.locator('#deviceOptIn').focus();
      await browser.evaluate(() => window.scrollTo(0, 0));
      const before = await browser.evaluate(() => scrollY);
      // A later successful background refresh must not anchor again.
      await browser.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect.poll(async () => browser.evaluate(async () => (await import('/js/notifications.js')).view.preference.observed_at)).not.toBe(observed);
      await expect(browser.locator('#prefSave')).toBeEnabled();
      await expect.poll(async () => browser.evaluate(() => scrollY)).toBe(before);
      await expect(browser.locator('#deviceOptIn')).toBeFocused();
    });
  }
}
