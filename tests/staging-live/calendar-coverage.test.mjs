import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, fixtureServer } from '../../test/browser-harness.mjs';
import { calendarCases, declaredStates, calendarState, destinationOwnership, recordCalendarState } from '../../scripts/e2e-staging/state-plan.mjs';
import { runCalendarCase, readCalendarContext, prepareCalendarRecord, assertCalendarAction } from '../../scripts/e2e-staging/calendar-coverage.mjs';
import { createSweepRun } from '../../scripts/e2e-staging/resume.mjs';
import { sweepOwnerStates } from '../../scripts/e2e-staging/owner-states.mjs';
import { inventory, CONTROL_SELECTOR, sweepScreen } from '../../scripts/e2e-staging/controls.mjs';

test('27 finite Calendar functional cases render correct dates on desktop and phone', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const seed = JSON.parse(await readFile(new URL('../../data/board-seed.json', import.meta.url)));
  // Existing native fixture adapter reads this ordinary synthetic seed.
  // Keep an upcoming date so agenda checks have an honest prerequisite.
  seed.deals[0].next_date = new Date().toISOString().slice(0, 10);
  const evidenceRoot = process.env.E2E_FINITE_TEST_EVIDENCE;
  if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 960 }], ['phone', { width: 390, height: 844 }]]) {
    const freshPage = async ({ path }) => {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      await page.route('**/data/board-seed.json', route => route.fulfill({ json: seed }));
      await page.goto(server.origin + path, { waitUntil: 'networkidle' });
      return page;
    };
    for (const item of calendarCases) await t.test(name + ' ' + item.id, async () => {
      const spec = declaredStates(['/calendar']).find(row => row.case === item.id);
      const result = await runCalendarCase({ spec, freshPage, evidence: async page => {
        if (evidenceRoot) {
          const path = join(evidenceRoot, name + '-' + item.id + '.png');
          await page.screenshot({ path, fullPage: true });
          return path;
        }
        return '/synthetic/' + name + '/' + item.id + '.png';
      } });
      assert.equal(result.status, 'passed', JSON.stringify(result.failure));
      assert.deepEqual(result.steps, item.steps);
      assert.equal(result.assertions.cells, result.assertions.state.view === 'month' ? 42 : 7);
    });
    await t.test(name + ' native date controls terminate without recursively scheduling new periods', async () => {
      const fresh = async () => {
        const page = await freshPage({ path: '/calendar' });
        await readCalendarContext(page);
        await page.locator(CONTROL_SELECTOR).evaluateAll(nodes => {
          const day = document.querySelector('.cal-day-open');
          const entry = document.querySelector('.cal-chip');
          for (const node of nodes) if (!node.matches('#calPrev,#calNext,#calToday,#calRefresh,#calViewSwitch [data-view]') && node !== day && node !== entry) node.inert = true;
        });
        return page;
      };
      const result = await sweepScreen({ freshPage: fresh, screen: { name: 'Calendar', path: '/calendar', surface: 'app' }, target: name,
        routedPaths: ['/calendar'], waitMs: 20, limit: 25, evidence: async () => '/synthetic/calendar-native-operation.png' });
      assert.equal(result.failure, null, JSON.stringify(result.failure));
      assert.equal(result.exhausted, false);
      assert.ok(result.controls.length >= 7 && result.controls.length <= 8);
      assert.equal(result.traversal, undefined);
      for (const action of ['prev', 'next', 'today', 'refresh', 'view', 'day']) assert.ok(result.delegations.some(row => row.witness?.action === action && row.witness.assertions_passed));
    });
    await t.test(name + ' record seed preserves exact entry and selected deal', async () => {
      const first = await freshPage({ path: '/calendar' });
      const data = await readCalendarContext(first), spec = recordCalendarState(data.entries[0]);
      await first.context().close();
      const next = await freshPage({ path: spec.url });
      try {
        const witness = await prepareCalendarRecord(next, spec);
        assert.equal(witness.binding, spec.entry_binding);
        assert.ok((await inventory(next, { scope: 'synthetic-record' })).every(row => row.identity.startsWith('control-state.v1:')));
        await assert.rejects(prepareCalendarRecord(next, { ...spec, entry_binding: 'control-state.v1:' + '0'.repeat(64) }), /record-state-changed/);
      } finally { await next.context().close(); }
    });
    await t.test(name + ' action validator rejects a wrong date even when a click produced signals', async () => {
      const page = await freshPage({ path: '/calendar?view=month&d=2026-01-31' });
      try {
        await assert.rejects(assertCalendarAction(page, { calendar: { action: 'next' } }, page.url()), /operation-result-incorrect/);
        await page.locator('#calNext').click();
        const witness = await assertCalendarAction(page, { calendar: { action: 'next' } }, server.origin + '/calendar?view=month&d=2026-01-31');
        assert.equal(witness.after.d, '2026-02-28');
      } finally { await page.context().close(); }
    });
  }
});

test('only typed Calendar operations are finite; unknown queries remain incomplete and search/detail queries remain distinct', () => {
  const base = 'http://127.0.0.1:3000';
  const decide = (before, after, control = {}) => destinationOwnership({ beforeURL: base + before, afterURL: base + after, control, routedPaths: ['/calendar', '/ideas-events', '/search', '/deals'] });
  for (const path of ['/calendar?q=important', '/calendar?d=2026-02-30', '/calendar?view=month&view=week']) assert.equal(decide('/', path).kind, 'unclassified');
  assert.equal(decide('/calendar?d=2026-09-24', '/calendar?d=2026-09-25').kind, 'unclassified');
  assert.equal(decide('/calendar?d=2026-09-24', '/calendar?d=2026-09-25', { calendar: { action: 'next' } }).kind, 'calendar-operation');
  assert.equal(decide('/', '/search?q=synthetic').kind, 'discover');
  assert.equal(decide('/', '/deals?deal=synthetic-record').kind, 'discover');
  assert.equal(decide('/ideas-events?tab=ideas', '/ideas-events?tab=ideas').kind, 'discover');
  assert.equal(decide('/', '/ideas-events?tab=events', { href: '/ideas-events?tab=events' }).states.length, 2);
  assert.equal(calendarState('/calendar?view=week&d=2028-02-29').d, '2028-02-29');
});

test('owner execution runs all Calendar operations and durably registers every real record before attempting its scoped UI', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const seed = JSON.parse(await readFile(new URL('../../data/board-seed.json', import.meta.url)));
  seed.deals[0].next_date = new Date().toISOString().slice(0, 10);
  const target = { name: 'phone', surface: 'app', viewport: { width: 390, height: 844 } };
  const screen = { name: 'Calendar', surface: 'app', path: '/calendar' };
  const run = createSweepRun({ targets: [target], routedScreens: [screen] });
  const attempted = new Set(), records = new Set();
  let published;
  const freshPageFor = (_target, _screen, spec) => async (request = {}) => {
    const page = await browser.newPage({ viewport: target.viewport, reducedMotion: 'reduce' });
    await page.route('**/data/board-seed.json', route => route.fulfill({ json: seed }));
    await page.goto(server.origin + (request.path || spec.url || '/calendar'), { waitUntil: 'networkidle' });
    if (spec.kind === 'calendar-record') await prepareCalendarRecord(page, spec);
    return page;
  };
  await sweepOwnerStates({ run, targets: [target], routedScreens: [screen], freshPageFor,
    evidence: async () => '/synthetic/calendar-owner-witness.png',
    persist: async () => { published = structuredClone(run.snapshot()); },
    sweep: async ({ freshPage, identityScope }) => {
      attempted.add(identityScope);
      assert.ok(published.stateObligations.some(entry => entry.key === identityScope), 'record is committed before its owner acts');
      const page = await freshPage();
      try {
        const current = await readCalendarContext(page);
        const entry = published.stateObligations.find(row => row.key === identityScope);
        if (entry.spec.kind === 'calendar-record') {
          assert.ok(current.selected?.id && current.focusEntry);
          records.add(entry.spec.entry_binding);
          assert.ok((await inventory(page, { scope: identityScope })).every(row => row.identity.startsWith('control-state.v1:')));
        }
        // This bounded integration test verifies owner seeding and dispatch.
        // It explicitly leaves generic UI coverage incomplete.
        return { ...screen, target: target.name, state_scope: identityScope, reached: true, controls: [],
          failure: { phase: 'owner-state', code: 'bounded-test-inventory-not-measured', openers: [] } };
      } finally { await page.context().close(); }
    } });
  const snapshot = run.snapshot();
  assert.equal(snapshot.stateObligations.filter(entry => entry.spec.kind === 'calendar-operation' && entry.status === 'passed').length, 27);
  const registered = snapshot.stateObligations.filter(entry => entry.spec.kind === 'calendar-record');
  assert.ok(registered.length > 0);
  assert.equal(records.size, registered.length);
  for (const entry of registered) {
    assert.ok(attempted.has(entry.key));
    assert.ok(entry.sources.some(source => source.kind === 'calendar-read' && source.entry_binding === entry.spec.entry_binding));
  }
  assert.equal(run.verdict([]).completed, false);
});
