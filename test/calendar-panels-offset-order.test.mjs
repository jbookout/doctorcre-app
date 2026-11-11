import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

test('calendar snapshot transitions compare instants and preserve day semantics', async t => {
  const outDir = temporaryDirectory('calendar-offset-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: process.cwd(), outDir });
  const dom = new JSDOM('<div id="left"></div><div id="right"></div>');
  t.after(() => dom.window.close());
  let disconnected = false;
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    ResizeObserver: class { observe() {} disconnect() { disconnected = true; } } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-05T12:30:00Z') });
  const { mountCalendarPanels } = await import(pathToFileURL(join(outDir, 'site/js/ui-calendar-panels.generated.js')));
  const left = document.querySelector('#left'), right = document.querySelector('#right');
  const panel = await mountCalendarPanels(left, right);
  const titles = node => [...node.querySelectorAll('.calendar-panel-meeting a')].map(a => a.textContent);
  const row = (title, start, end = '2026-11-05T20:00:00Z', extra = {}) => ({ title, start, end, ...extra });
  panel.clear();
  assert.match(left.textContent, /Schedule unavailable/);
  panel.render({ state: 'empty', items: [] });
  assert.match(left.textContent, /No upcoming meetings returned/);
  panel.clear();
  assert.match(left.textContent, /Schedule unavailable/);
  assert.match(right.textContent, /Schedule unavailable/);
  const items = [row('Later', '2026-11-05T08:00:00-06:00'), row('Earlier', '2026-11-05T13:00:00Z'),
    row('Tie', '2026-11-05T07:00:00-06:00'),
    row('Future offset', '2026-11-05T06:00:00-06:00', '2026-11-05T07:00:00-06:00'),
    row('Elapsed offset', '2026-11-05T12:00:00+02:00', '2026-11-05T13:00:00+02:00'),
    row('Boundary', '2026-11-05T12:00:00Z', '2026-11-05T12:30:00Z')];
  await t.test('empty calendar renders delayed ready rows directly', async () => {
    panel.render({ state: 'empty', items: [] });
    assert.match(left.textContent, /No upcoming meetings returned/);
    assert.match(right.textContent, /No meetings scheduled today/);
    assert.deepEqual(titles(left), []);
    assert.deepEqual(titles(right), []);
    await new Promise(resolve => setTimeout(resolve, 0));
    panel.render({ state: 'ready', items });
    assert.deepEqual(titles(left), ['Future offset', 'Boundary', 'Earlier', 'Tie', 'Later']);
    assert.deepEqual(titles(right), ['Elapsed offset', 'Future offset', 'Boundary']);
    for (const node of [left, right]) {
      assert.equal(node.querySelector('[role="status"]'), null);
      assert.doesNotMatch(node.textContent, /No upcoming meetings returned|No meetings scheduled today/);
    }
  });
  panel.render({ state: 'ready', items });
  assert.deepEqual(titles(left), ['Future offset', 'Boundary', 'Earlier', 'Tie', 'Later']);
  assert.deepEqual(titles(right), ['Elapsed offset', 'Future offset', 'Boundary']);
  panel.render({ state: 'ready', items: items.map(item => ({ ...item, start: new Date(item.start).toISOString(), end: new Date(item.end).toISOString() })) });
  assert.deepEqual(titles(left), ['Future offset', 'Boundary', 'Earlier', 'Tie', 'Later']);
  panel.render({ state: 'partial', items });
  assert.match(left.textContent, /coverage is incomplete/);
  assert.deepEqual(titles(left), ['Future offset', 'Boundary', 'Earlier', 'Tie', 'Later']);
  panel.clear();
  assert.match(left.textContent, /Schedule unavailable/);
  assert.match(right.textContent, /Schedule unavailable/);
  assert.deepEqual(titles(left), []);
  assert.deepEqual(titles(right), []);
  panel.render({ state: 'ready', items: [row('Chicago previous day', '2026-11-06T01:00:00Z'), row('All day', '2026-11-06', '2026-11-07', { all_day: true })] });
  assert.equal([...left.querySelectorAll('.calendar-panel-meeting a')].find(a => a.textContent === 'Chicago previous day').getAttribute('href'), '/calendar?day=2026-11-05&d=2026-11-05');
  assert.equal([...left.querySelectorAll('.calendar-panel-meeting a')].find(a => a.textContent === 'All day').getAttribute('href'), '/calendar?day=2026-11-06&d=2026-11-06');
  assert.match(left.textContent, /Nov 6 · All day/);
  panel.render({ state: 'ready', items: [{ title: 'Invalid', start: 'invalid', end: 'invalid' }] });
  assert.match(left.textContent, /Schedule unavailable/);
  panel.render({ state: 'ready', items: [items[0]] });
  t.mock.timers.setTime(Date.parse('2026-11-06T00:00:00Z'));
  panel.render({ state: 'ready', items: [items[0]] });
  assert.deepEqual(titles(left), []);
  assert.deepEqual(titles(right), ['Later']);
  panel.render({ state: 'empty', items: [] });
  assert.match(left.textContent, /No upcoming meetings returned/);
  assert.match(right.textContent, /No meetings scheduled today/);
  assert.deepEqual(titles(right), []);
  panel.render({ state: 'ready', items: [row('Before teardown', '2026-11-06T13:00:00Z', '2026-11-06T14:00:00Z')] });
  assert.deepEqual(titles(left), ['Before teardown']);
  left.remove();
  panel.clear();
  assert.equal(disconnected, true);
});
