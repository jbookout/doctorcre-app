import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium, fixtureServer } from './browser-harness.mjs';

let outDir;
before(async () => { outDir = temporaryDirectory('calendar-fit-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => { await rm(outDir, { recursive: true, force: true }); });

for (const theme of ['light', 'dark']) for (const count of [0, 1, 2, 3, 6]) test(`Calendar rail fits ${count} meetings in ${theme}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ timezoneId: 'America/Chicago' });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    const value = name === 'calendar-meeting-prep' ? { state: count ? 'ready' : 'empty', items: Array.from({ length: count }, (_, i) => ({ title: `Synthetic meeting ${i + 1} with the practice team to review the upcoming office requirements`, start: new Date(Date.now() + 3600000 * (i + 1)).toISOString(), end: new Date(Date.now() + 3600000 * (i + 2)).toISOString() })) }
      : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  });
  for (const [width, height] of [[1024, 700], [1024, 768], [1280, 720], [1280, 800], [1440, 900], [390, 844], [1024, 700]]) {
    await page.setViewportSize({ width, height });
    if (!page.url().startsWith(server.origin)) await page.goto(`${server.origin}/calendar?mode=live`);
    if (width === 390) await page.locator('#appSidebarToggle').click();
    await page.locator('#appCalendarSlot a').first().waitFor();
    if (count) await page.locator('#appScheduleSlot .calendar-panel-meeting').first().waitFor({ state: 'attached' });
    else await page.locator('#appCalendarSlot').getByText('No upcoming meetings returned.').waitFor({ state: 'attached' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const rail = page.locator('#appSidebar');
    const visible = rail.locator('.calendar-panel-meeting:visible');
    const shown = await visible.count();
    const more = rail.getByRole('link', { name: `${count - shown} more ↗`, exact: true });
    if (count > shown) { assert.equal(await more.count(), 1); assert.equal(await more.getAttribute('href'), '/calendar'); }
    const fit = await rail.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return { height: node.clientHeight, scroll: node.scrollHeight, overflow: getComputedStyle(node).overflowY, clipped: [...node.querySelectorAll('.calendar-panel-meeting, .calendar-panel > a')].filter(n => n.getClientRects().length).some(n => n.getBoundingClientRect().bottom > bounds.bottom || n.getBoundingClientRect().top < bounds.top) };
    });
    if (count === 3) await page.screenshot({ path: `/tmp/wr617-s1-j30-shots/calendar-${width}x${height}-${theme}.png`, animations: 'disabled', fullPage: true });
    assert.ok(fit.scroll <= fit.height, `${width}x${height}: ${JSON.stringify(fit)}`);
    assert.equal(fit.clipped, false);
    assert.ok(!['scroll', 'auto'].includes(fit.overflow), 'no scrollbar inside calendar rail');
    if (width === 1440) assert.ok(shown >= Math.min(count, 3), 'use available height for complete previews');
  }
});
