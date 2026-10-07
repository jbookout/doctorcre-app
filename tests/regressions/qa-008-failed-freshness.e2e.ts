import { expect } from 'e2e';
import { reproTest } from './support.mjs';

const test = reproTest();
const surfaces = [
  { name: 'Tours', path: '/tours?mode=live', failure: '#tour-library-state', freshness: '#planner-updated', refresh: '#planner-refresh', settled: /unavailable|sign in/i },
  { name: 'Leads', path: '/leads?mode=live', failure: '#leadBoardError', freshness: '#boardUpdated', refresh: '#refreshBoard', settled: /interrupted|sign-in/i },
  { name: 'Deals', path: '/deals?mode=live', failure: '#boardLive', freshness: '#boardAsOf', refresh: '#retryRead', settled: /could not be read|unavailable|sign in/i },
];
for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) for (const surface of surfaces) for (const status of [503, 401, 403]) {
  test(`QA-008 ${surface.name} freshness settles after ${status} retry${surface.name === 'Tours' ? '' : ' and recovers'} at ${viewport.width}px`, { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser }) => {
    await browser.setViewport(viewport);
    const refresh = viewport.width < 760 ? '#appSyncRefresh' : surface.refresh;
    // The phone shows planner feedback while its library lives in the sidebar.
    const failure = viewport.width < 760 && surface.name === 'Tours' ? '#plan-message' : surface.failure;
    let refusedReads = 0;
    const reject = route => {
      if (surface.name === 'Tours' ? route.request.url.includes('/api/tours/library')
        : JSON.parse(route.request.postData || '{}').params?.name === 'deal-room-board') refusedReads += 1;
      return route.fulfill({ status, json: { ok: false, error: status === 401 ? 'unauthorized' : 'temporarily_unavailable', code: status === 401 ? 'unauthorized' : 'temporarily_unavailable' } });
    };
    await browser.route('**/api/**', reject);
    await browser.route('**/mcp', reject);
    await app.open(surface.path);
    await expect(browser.locator(failure)).toContainText(surface.settled);
    await expect(browser.locator(surface.freshness)).toContainText(/unavailable/i);
    await expect(browser.locator('.app-layout-status')).not.toContainText('Updating…');
    const beforeRetry = refusedReads;
    await browser.locator(refresh).focus();
    await browser.locator(refresh).press('Enter');
    await expect.poll(() => refusedReads).toBeGreaterThan(beforeRetry);
    await expect(browser.locator(failure)).toContainText(surface.settled);
    await expect(browser.locator(surface.freshness)).toContainText(/unavailable/i);
    // These local interactions repaint the settled failed read.
    if (surface.name === 'Leads') {
      await browser.locator('#appSidebarToggle').tap();
      await browser.locator('#leadSearch').fill('Demo');
      await browser.locator('[data-layout-close="sidebar"]').tap();
    }
    if (surface.name === 'Deals') await browser.locator('#listView').tap();
    await expect(browser.locator(surface.freshness)).toContainText(/unavailable/i);
    // The fixture server does not implement Tours' legacy library transport;
    // its existing regression covers failed retries, while Leads/Deals recover.
    if (status === 503) await app.screenshot(`failed-freshness-${surface.name}-${viewport.width}`);
    if (surface.name === 'Tours') return;
    await browser.unroute('**/api/**');
    await browser.unroute('**/mcp');
    await browser.locator(refresh).tap();
    await expect(browser.locator(surface.freshness)).toContainText(/Updated/i);
    if (surface.name === 'Leads') {
      await browser.locator('#appSidebarToggle').tap();
      await browser.locator('#leadSearch').fill('');
      await browser.locator('[data-layout-close="sidebar"]').tap();
    }
    if (surface.name === 'Deals') await browser.locator('#boardView').tap();
    await expect(browser.locator(surface.freshness)).toContainText(/Updated/i);
    await expect(browser.locator('.app-layout-status')).not.toContainText(/Updating|unavailable/i);
  });
}
