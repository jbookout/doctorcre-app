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
    const { mountCalendarPanels } = await import('/js/ui-calendar-panels.generated.js');
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

for (const mode of ['import-failure', 'detached']) test(`calendar caller ${mode} while loading`, async t => {
  const run = await scenario(t, { root: join(outDir, 'site') });
  const { page } = run;
  await page.route('**/calendar-caller-fixture', route => route.fulfill({ contentType: 'text/html', body: '<header id="host"></header><main></main>' }));
  await page.route('**/mcp', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
  await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
  await page.route('**/auth/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
  if (mode === 'import-failure') await page.route('**/js/ui-calendar-panels.generated.js', route => route.abort());
  else await page.route('**/js/ui-calendar-panels.generated.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    globalThis.calendarModuleLoaded = true;
    export async function mountCalendarPanels(left, right) {
      left.textContent = 'Mounted calendar';
      right.textContent = 'Mounted schedule';
    }
  ` }));
  await run.open('/calendar-caller-fixture');
  await page.evaluate(async () => {
    const { mountAppLayout } = await import('/js/app-layout.js');
    const ready = new Promise(resolve => { window.releaseCalendar = resolve; });
    mountAppLayout(document, document.querySelector('#host'), '/vendors', { ready });
  });
  assert.equal(await page.locator('#appCalendarSlot').textContent(), '');
  if (mode === 'detached') await page.evaluate(() => {
    window.detachedCalendar = document.querySelector('#appLayout');
    window.detachedCalendar.remove();
  });
  await page.evaluate(() => window.releaseCalendar());
  if (mode === 'import-failure') {
    for (const id of ['#appCalendarSlot', '#appScheduleSlot']) {
      await page.locator(id).filter({ hasText: 'Calendar unavailable. Reload to try again.' }).waitFor();
    }
  } else {
    await page.waitForFunction(() => window.calendarModuleLoaded === true);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    assert.deepEqual(await page.evaluate(() => [...window.detachedCalendar.querySelectorAll('#appCalendarSlot, #appScheduleSlot')].map(node => node.textContent)), ['', '']);
  }
});
