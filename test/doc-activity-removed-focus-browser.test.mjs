import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, pausedClock, settles } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { createDocActivityFixture } from '../js/doc-activity-fixture.js';

async function open(t, { width = 1280, theme = 'light', undoSucceeds = false } = {}) {
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
  let entries = original.entries, fail = false, held = null, release = null, undoHeld = null, releaseUndo = null;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/mcp', async route => {
    const { params } = route.request().postDataJSON();
    calls.push(params);
    if (params.name === 'read-doc-activity') {
      if (held) { const wait = held; held = null; await wait; }
      if (fail) return route.fulfill({ status: 503, body: '' });
      return route.fulfill({ json: { result: { content: [{ text: JSON.stringify({ ...original, entries }) }] } } });
    }
    if (params.name === 'revert-deal-field') {
      if (undoHeld) { const wait = undoHeld; undoHeld = null; await wait; }
      if (!undoSucceeds) return route.fulfill({ status: 504, body: '' });
      return route.fulfill({ json: { result: { content: [{ text: JSON.stringify(await fixture.undo(params.arguments)) }] } } });
    }
    const answers = {
      'calendar-meeting-prep': { state: 'empty', items: [] },
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
  if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('[data-pref="theme"]').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  t.after(() => assert.deepEqual(errors, []));
  return {
    page, calls, original: original.entries,
    replace: rows => { entries = rows; },
    fail: () => { fail = true; },
    hold: () => { held = new Promise(resolve => { release = resolve; }); },
    release: () => release(),
    holdUndo: () => { undoHeld = new Promise(resolve => { releaseUndo = resolve; }); },
    releaseUndo: () => releaseUndo(),
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

for (const direction of ['next', 'previous']) test(`removed activity focuses the ${direction} surviving row`, async t => {
  const app = await open(t), { page, original } = app;
  const index = direction === 'next' ? 1 : 4;
  await page.locator('.activity-open').nth(index).focus();
  app.replace(direction === 'next' ? [original[0], original[3], original[4]] : [original[0], original[2]]);
  await app.refresh();
  await settles(async () => assert.equal(await focused(page), original[direction === 'next' ? 3 : 2].id));
});

test('unchanged snapshots preserve nodes and changed snapshots preserve surviving Undo identity', async t => {
  const app = await open(t), { page, original } = app;
  await page.locator('[data-undo]').first().focus();
  const before = await page.locator('[data-undo]').first().elementHandle();
  await app.refresh();
  assert.equal(await before.evaluate(button => button === document.activeElement && button.isConnected), true);
  app.replace(original.slice(0, 4));
  await app.refresh();
  await settles(async () => assert.equal(await page.locator('[data-undo]').first().evaluate(button => button === document.activeElement), true));
});

test('a filter chosen during a pending read keeps focus when the event disappears', async t => {
  const app = await open(t), { page } = app;
  await page.locator('.activity-open').first().focus();
  app.hold();
  const read = page.waitForRequest(request => request.url().endsWith('/mcp') && request.postDataJSON().params.name === 'read-doc-activity');
  const refreshed = app.refresh();
  await read;
  await page.locator('[name=partner]').focus();
  app.replace([]);
  app.release();
  await refreshed;
  await page.getByText('No activity', { exact: true }).waitFor();
  assert.equal(await page.locator('[name=partner]').evaluate(select => select === document.activeElement), true);
});

test('failed reads preserve readable rows and unknown Undo never becomes done', async t => {
  const app = await open(t), { page } = app;
  await page.locator('[data-undo]').first().click();
  await page.getByRole('button', { name: 'Check undo', exact: true }).waitFor();
  const before = await page.locator('[data-undo]').first().elementHandle();
  await before.focus();
  app.fail();
  await app.refresh();
  await page.getByText('Activity temporarily unavailable', { exact: true }).waitFor();
  assert.equal(await page.locator('.activity-row').count(), 5);
  assert.equal(await before.evaluate(button => button === document.activeElement && button.isConnected), true);
  assert.equal(await page.getByRole('button', { name: 'Check undo', exact: true }).count(), 1);
  assert.equal(app.calls.filter(call => call.name === 'revert-deal-field').length, 1);
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`keyboard detail removal and empty recovery at ${width} in ${theme}`, async t => {
    const app = await open(t, { width, theme }), { page, original } = app;
    await page.locator('.activity-open').nth(1).focus();
    await page.keyboard.press('Enter');
    await page.locator('#activityDetail[open]').waitFor();
    assert.equal(await focused(page), 'detailClose');
    await page.keyboard.press('Escape');
    assert.equal(await focused(page), original[1].id);
    await page.keyboard.press('Enter');
    app.replace([original[0], original[3]]);
    await app.refresh();
    await settles(async () => assert.equal(await focused(page), original[3].id));
    assert.equal(await page.locator('#activityDetail').evaluate(dialog => dialog.open), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const evidence = new URL('../.github/pr-evidence/WR39.S1.J17/', import.meta.url);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: new URL(`${width}-${theme}-next.png`, evidence).pathname, fullPage: true });
    await page.keyboard.press('Enter');
    app.replace([]);
    await app.refresh();
    await settles(async () => assert.equal(await focused(page), 'activityRefresh'));
    assert.equal(await page.locator('#activityDetail').evaluate(dialog => dialog.open), false);
    await page.screenshot({ path: new URL(`${width}-${theme}-empty.png`, evidence).pathname, fullPage: true });
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(app.calls.filter(call => call.name === 'read-doc-activity').length, 3);
  });
}

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`detail Undo then removed event restores next row focus at ${width} in ${theme}`, async t => {
    const app = await open(t, { width, theme, undoSucceeds: true }), { page, original } = app;
    await page.locator('.activity-open').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('#activityDetail[open]').waitFor();
    await page.locator('#detailUndo').focus();
    app.hold();
    const read = page.waitForRequest(request => request.url().endsWith('/mcp') && request.postDataJSON().params.name === 'read-doc-activity');
    await page.keyboard.press('Enter');
    await read;
    assert.equal(await page.locator('#detailUndo').isDisabled(), true);
    assert.equal(await page.locator('#activityDetail').evaluate(dialog => dialog.open), true);
    assert.equal(await focused(page), 'detailClose');
    app.replace(original.slice(1));
    app.release();
    await page.locator('#activityDetail').waitFor({ state: 'hidden' });
    assert.equal(await focused(page), original[1].id);
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(app.calls.filter(call => call.name === 'revert-deal-field').length, 1);
    assert.equal(app.calls.filter(call => call.name === 'read-doc-activity').length, 2);
  });
}

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  for (const undoSucceeds of [true, false]) test(`detail Undo keeps dialog focus on ${undoSucceeds ? 'success' : 'Check undo'} at ${width} in ${theme}`, async t => {
    const app = await open(t, { width, theme, undoSucceeds }), { page } = app;
    await page.locator('.activity-open').first().click();
    await page.locator('#detailUndo').focus();
    app.holdUndo();
    const sent = page.waitForRequest(request => request.url().endsWith('/mcp') && request.postDataJSON().params.name === 'revert-deal-field');
    await page.keyboard.press('Enter');
    await sent;
    assert.equal(await page.locator('#detailUndo').isDisabled(), true);
    assert.equal(await focused(page), 'detailClose');
    await page.locator('#detailOriginal summary').focus();
    app.releaseUndo();
    await page.locator('#detailUndo').getByText(undoSucceeds ? 'Undone' : 'Check undo', { exact: true }).waitFor();
    assert.equal(await page.locator('#detailOriginal summary').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#detailUndo').isDisabled(), undoSucceeds);
    assert.equal(await page.locator('#activityDetail').evaluate(dialog => dialog.open), true);
    assert.equal(app.calls.filter(call => call.name === 'revert-deal-field').length, 1);
  });

  test(`Undo announcement survives completed background refreshes at ${width} in ${theme}`, async t => {
    const app = await open(t, { width, theme, undoSucceeds: true }), { page, original } = app;
    await page.locator('.activity-open').first().click();
    app.hold();
    const read = page.waitForRequest(request => request.url().endsWith('/mcp') && request.postDataJSON().params.name === 'read-doc-activity');
    await page.locator('#detailUndo').click();
    await read;
    const announcement = `Change undone: ${original[0].record.name}`;
    assert.equal(await page.locator('#activityStatus').textContent(), announcement);
    app.replace(original.slice(0, 4));
    app.release();
    await page.waitForFunction(() => document.querySelectorAll('.activity-row').length === 4);
    assert.equal(await page.locator('#activityStatus').textContent(), announcement);
    app.replace(original.slice(0, 3));
    await page.clock.runFor(60_001);
    await page.waitForFunction(() => document.querySelectorAll('.activity-row').length === 3);
    assert.equal(await page.locator('#activityStatus').textContent(), announcement);
    assert.equal(await page.locator('#activityStatus').getAttribute('role'), 'status');
    assert.equal(await page.locator('#activityStatus').getAttribute('aria-live'), 'polite');
    const evidence = new URL('../.github/pr-evidence/WR39.S1.J39/', import.meta.url);
    await mkdir(evidence, { recursive: true });
    await page.locator('#detailClose').focus();
    await page.screenshot({ path: new URL(`${width}-${theme}-undo.png`, evidence).pathname, fullPage: true });
    await page.keyboard.press('Escape');
    await app.refresh();
    assert.equal(await page.locator('#activityStatus').textContent(), '');
  });
}
