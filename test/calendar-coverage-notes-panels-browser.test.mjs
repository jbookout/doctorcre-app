import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { scenario } from './browser-scenario.mjs';
import { observeCoverage, producerFixture } from '../scripts/prove-calendar-coverage-notes-panels.mjs';
import { carrInterface } from './carr-contract.mjs';

let outDir;
before(async () => { outDir = temporaryDirectory('coverage-browser-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(() => rm(outDir, { recursive: true, force: true }));
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`coverage lifecycle ${width} ${theme}`, async t => {
  assert.ok(carrInterface.mcp_operations.includes('calendar-meeting-prep'));
  assert.ok(carrInterface.morning_brief.section_states.includes(producerFixture.state));
  assert.ok(producerFixture.notes.every(note => typeof note === 'string' && note.trim()));
  const run = await scenario(t, { root: join(outDir, 'site'), now: '2026-11-05T12:30:00Z', page: { viewport: { width, height: 900 }, colorScheme: theme } });
  const { page } = run;
  await page.route('**/coverage-fixture', route => route.fulfill({ contentType: 'text/html', body: `<link rel="stylesheet" href="/css/app.css"><div class="app-layout-sidebar" style="height:850px"><div id="left"></div></div><div id="right"></div>` }));
  await run.open('/coverage-fixture');
  const observation = await observeCoverage(page);
  assert.deepEqual(observation.notes, producerFixture.notes);
  assert.deepEqual(observation.rightNotes, producerFixture.notes);
  assert.equal(observation.partial, true);
  assert.equal(observation.meetings, 1);
  for (const id of ['left', 'right']) {
    const summary = page.locator(`#${id} summary`);
    assert.equal(await summary.textContent(), 'Calendar coverage');
    await summary.focus();
    await page.keyboard.press('Enter');
    assert.equal(await summary.evaluate(node => node.parentElement.open), true);
    await page.keyboard.press('Enter');
    assert.equal(await summary.evaluate(node => node.parentElement.open), false);
  }
  const lifecycle = await page.evaluate(async fixture => {
    const { mountCalendarPanels } = await import('/js/ui-calendar-panels.generated.js');
    const left = document.createElement('div'), right = document.createElement('div');
    document.body.append(left, right);
    const panel = await mountCalendarPanels(left, right);
    const { createLiveClient } = await import('/js/live-client.js');
    let response;
    const client = createLiveClient({ fetchImpl: async () => new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(response) }] } })) });
    async function render(value) { response = value; panel.render(await client.calendarMeetingPrep()); }
    panel.clear();
    const unavailable = left.textContent.includes('Schedule unavailable');
    await render(fixture);
    const beforeFilter = left.textContent;
    await render(structuredClone(fixture));
    const filterStable = left.textContent === beforeFilter;
    left.querySelector('details').open = true;
    await render({ ...fixture, notes: ['Replacement warning'] });
    const refreshed = !left.querySelector('details').open && !left.textContent.includes(fixture.notes[0]);
    for (const notes of [undefined, null, 'bad', [null, 7, '']]) {
      await render({ ...fixture, notes });
      if (!left.textContent.includes('Coverage details unavailable.') || left.querySelectorAll('.calendar-panel-meeting').length !== 1) throw Error('Malformed notes hid meeting');
    }
    await render({ ...fixture, notes: ['  Same  ', 'Same', '', '<img src=x onerror=alert(1)>', 'x'.repeat(800), ...Array.from({ length: 22 }, (_, i) => `Warning ${i}`)] });
    const notes = [...left.querySelectorAll('details li')].map(n => n.textContent);
    const bounded = notes.length === 20 && notes.every(n => n.length <= 500) && notes.filter(n => n === 'Same').length === 1;
    const omitted = left.textContent.includes('5 more coverage notes not shown.') && left.textContent.includes('Long notes shortened to 500 characters.');
    const escaped = !left.querySelector('img') && notes.includes('<img src=x onerror=alert(1)>');
    await render({ ...fixture, items: [] });
    const emptyPartial = left.textContent.includes('coverage is incomplete') && left.querySelectorAll('details li').length === fixture.notes.length;
    panel.clear();
    const cleared = !left.textContent.includes(fixture.notes[0]) && !left.querySelector('details');
    await render({ state: 'ready', items: fixture.items, notes: [] });
    const ready = !left.querySelector('details') && !left.textContent.includes('incomplete');
    await render(fixture);
    left.querySelector('details').open = true;
    panel.clear();
    const clearedOpen = !left.querySelector('details');
    left.remove(); right.remove();
    return { filterStable, unavailable, refreshed, bounded, omitted, escaped, emptyPartial, cleared, ready, clearedOpen };
  }, producerFixture);
  assert.deepEqual(lifecycle, Object.fromEntries(['filterStable', 'unavailable', 'refreshed', 'bounded', 'omitted', 'escaped', 'emptyPartial', 'cleared', 'ready', 'clearedOpen'].map(key => [key, true])));
});

test('coverage disclosure retains resized calendar links in the mounted rail', async t => {
  const run = await scenario(t, { root: join(outDir, 'site'), now: '2026-11-05T12:30:00Z' });
  const { page } = run;
  await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme: 'dark', walkthroughSeen: { joe: true } })));
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', route => {
    const { name } = route.request().postDataJSON().params;
    const value = name === 'calendar-meeting-prep' ? producerFixture : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  });
  await run.open('/calendar?mode=live');
  const summary = page.locator('#appCalendarSlot summary');
  await summary.waitFor();
  await summary.click();
  for (const [width, height] of [[1440, 900], [1024, 700], [390, 844], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    if (width === 390) await page.locator('#appSidebarToggle').click();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(100);
    const fit = await page.locator('#appSidebar').evaluate(node => {
      const bottom = node.getBoundingClientRect().bottom;
      const link = node.querySelector('#appCalendarSlot .calendar-panel > a:last-child');
      return { scroll: node.scrollHeight, height: node.clientHeight, linkFits: link.getBoundingClientRect().bottom <= bottom };
    });
    assert.ok(fit.scroll <= fit.height && fit.linkFits, `${width}x${height} ${JSON.stringify(fit)}`);
  }
});
