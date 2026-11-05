import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { scenario } from './browser-scenario.mjs';

let outDir;
before(async () => { outDir = temporaryDirectory('offset-browser-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => rm(outDir, { recursive: true, force: true }));
for (const width of [390, 1440]) test(`whole calendar island and keyboard at ${width}px`, async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: '2026-11-05T12:30:00Z', page: { viewport: { width, height: 900 } } });
  const { page } = run;
  await page.route('**/calendar-island-fixture', route => route.fulfill({ contentType: 'text/html', body: '<div id="left"></div><div id="right"></div>' }));
  await run.open('/calendar-island-fixture');
  const observation = await page.evaluate(async () => {
    const { mountCalendarPanels } = await import('/js/ui-calendar-panels.js');
    const left = document.querySelector('#left'), right = document.querySelector('#right');
    const panel = await mountCalendarPanels(left, right);
    const items = [
      { title: 'Later', start: '2026-11-05T08:00:00-06:00', end: '2026-11-05T10:00:00-06:00' },
      { title: 'Earlier', start: '2026-11-05T13:00:00Z', end: '2026-11-05T14:00:00Z' },
      { title: 'Future offset', start: '2026-11-05T06:00:00-06:00', end: '2026-11-05T07:00:00-06:00' },
      { title: 'Elapsed offset', start: '2026-11-05T12:00:00+02:00', end: '2026-11-05T13:00:00+02:00' },
    ];
    panel.clear();
    const unavailable = left.textContent.includes('Schedule unavailable');
    panel.render({ state: 'empty', items: [] });
    const empty = left.textContent.includes('No upcoming meetings returned');
    await new Promise(resolve => setTimeout(resolve, 0));
    panel.render({ state: 'partial', items });
    const partial = left.textContent.includes('coverage is incomplete');
    panel.render({ state: 'ready', items });
    return { unavailable, empty, partial, titles: [...left.querySelectorAll('.calendar-panel-meeting a')].map(a => a.textContent),
      schedule: [...right.querySelectorAll('.calendar-panel-meeting a')].map(a => a.textContent) };
  });
  assert.deepEqual(observation, { unavailable: true, empty: true, partial: true, titles: ['Future offset', 'Earlier', 'Later'], schedule: ['Elapsed offset', 'Future offset', 'Earlier'] });
  const earlier = page.locator('#left').getByRole('link', { name: 'Earlier', exact: true });
  await earlier.focus();
  assert.equal(await earlier.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Later');
  await earlier.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(url => url.pathname === '/calendar' && url.searchParams.get('day') === '2026-11-05');
});
