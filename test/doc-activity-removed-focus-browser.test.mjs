import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer, pausedClock, settles } from './browser-harness.mjs';
import { createDocActivityFixture } from '../js/doc-activity-fixture.js';

async function open(t, { width = 1280, theme = 'light' } = {}) {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  await pausedClock(page, new Date('2026-10-01T15:00:00Z'));
  await page.addInitScript(theme => {
    localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme }));
    localStorage.setItem('doctorcre:morning:joe', JSON.stringify({ day: '2026-10-01', lastShownAt: '2026-10-01T14:00:00Z' }));
  }, theme);
  const fixture = createDocActivityFixture(() => new Date('2026-10-01T15:00:00Z'));
  const original = await fixture.read(), calls = [], errors = [];
  let entries = original.entries, fail = false, held = null, release = null;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/mcp', async route => {
    const { params } = route.request().postDataJSON();
    calls.push(params);
    if (params.name === 'read-doc-activity') {
      if (held) { const wait = held; held = null; await wait; }
      if (fail) return route.fulfill({ status: 503, body: '' });
      return route.fulfill({ json: { result: { content: [{ text: JSON.stringify({ ...original, entries }) }] } } });
    }
    if (params.name === 'revert-deal-field') return route.fulfill({ status: 504, body: '' });
    const answers = {
      'deal-room-board': { actor: 'joe', deals: [] },
      'today-triage': { items: [] },
      'list-feature-switches': { ok: true, schema: 'feature-switches.v1', switches: [] },
      'list-doc-suggestions': { ok: true, suggestions: [] },
      'morning-brief': { state: 'ready', sponsor: 'joe', sections: { today: { state: 'empty', items: [] }, deals: { state: 'empty', items: [] }, loops: { state: 'empty', items: [] } } },
    };
    assert.ok(params.name in answers, `Unexpected operation ${params.name}`);
    return route.fulfill({ json: { result: { content: [{ text: JSON.stringify(answers[params.name]) }] } } });
  });
  await page.route('**/auth/session', route => route.fulfill({ json: { csrf_token: 'synthetic', actor: { slug: 'joe' } } }));
  await page.route('**/api/system-work/session', route => route.fulfill({ json: { csrf_token: 'synthetic', actor: { slug: 'joe' } } }));
  await page.goto(`${server.origin}/doc-activity?mode=live`);
  await page.locator('.activity-row').first().waitFor();
  t.after(() => assert.deepEqual(errors, []));
  return {
    page, calls, original: original.entries,
    replace: rows => { entries = rows; },
    fail: () => { fail = true; },
    hold: () => { held = new Promise(resolve => { release = resolve; }); },
    release: () => release(),
    refresh: async () => {
      const response = page.waitForResponse(response => response.url().endsWith('/mcp') && response.request().postDataJSON().params.name === 'read-doc-activity');
      await page.locator('#activityRefresh').evaluate(button => button.click());
      await response;
    },
  };
}

const focused = page => page.evaluate(() => document.activeElement.id || document.activeElement.dataset.open || document.activeElement.dataset.undo);

test('empty activity refresh recovers focus to Refresh activity', async t => {
  const app = await open(t);
  await app.page.locator('.activity-open').first().focus();
  app.replace([]);
  await app.refresh();
  await settles(async () => assert.equal(await focused(app.page), 'activityRefresh'));
  assert.equal(app.calls.filter(call => call.name === 'read-doc-activity').length, 2);
});
