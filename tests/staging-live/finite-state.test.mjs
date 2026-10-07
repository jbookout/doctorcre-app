import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from '../../test/browser-harness.mjs';
import { sweepScreen } from '../../scripts/e2e-staging/controls.mjs';
import { createSweepRun, readSweepCheckpoint } from '../../scripts/e2e-staging/resume.mjs';
import { persistSweepReport } from '../../scripts/e2e-staging/sweep.mjs';
import { sweepOwnerStates } from '../../scripts/e2e-staging/owner-states.mjs';
import { declaredStates } from '../../scripts/e2e-staging/state-plan.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
const targets = [{ name: 'desktop', surface: 'app', viewport: { width: 1440, height: 960 } }, { name: 'phone', surface: 'app', viewport: { width: 390, height: 844 } }];
const routes = ['/', '/deals', '/ideas-events'].map(path => ({ name: path, path, surface: 'app' }));
const setup = { release, findings: [], complete: true };
const origin = 'http://127.0.0.1:19999';
const evidence = async (_page, row) => '/synthetic/' + (row.key?.replaceAll('/', '-') || 'case') + '.png';
const makeRun = prior => createSweepRun({ targets, routedScreens: routes, prior });
const fixture = (path, query) => path !== '/ideas-events'
  ? '<main><a id="source-nav" href="/ideas-events?tab=events">Events</a></main>'
  : '<main><a id="ideas" href="/ideas-events?tab=ideas">Ideas</a><a id="events" href="/ideas-events?tab=events">Events</a><button id="drawer" onclick="document.querySelector(\'#panel\').hidden=false">Open ' + query + ' drawer</button><section id="panel" hidden><button id="nested" onclick="document.querySelector(\'#result\').textContent=\'changed\'">Nested ' + query + '</button></section><output id="result"></output></main>';
async function browserFixture(t) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  return (target, screen, spec) => async () => {
    const page = await browser.newPage({ viewport: target.viewport });
    await page.route(origin + '/**', route => {
      const url = new URL(route.request().url());
      return route.fulfill({ contentType: 'text/html', body: fixture(url.pathname, url.searchParams.get('tab')) });
    });
    await page.goto(origin + (spec?.url || screen.path));
    return page;
  };
}
const fastSweep = options => sweepScreen({ ...options, waitMs: 20, limit: 100 });
async function sourceSweep(run, factory, target, screen, checkpoint) {
  const result = await fastSweep({ freshPage: factory(target, screen), screen, target: target.name, prior: run.priorScreen(target.name, screen.path), evidence, routedPaths: routes.map(row => row.path), checkpoint: async partial => { run.record(partial); if (checkpoint) await checkpoint(partial); } });
  run.record(result);
  return result;
}

test('multiple source roots retain nav presses and both tab obligations; owners cover local drawers separately on both viewports', async t => {
  const factory = await browserFixture(t), run = makeRun();
  for (const target of targets) for (const screen of routes) {
    const result = await sourceSweep(run, factory, target, screen);
    assert.equal(result.failure, null);
    if (screen.path !== '/ideas-events') {
      assert.equal(result.controls.length, 1, 'source root delegates destination without crawling it');
      assert.equal(result.delegations[0].states.length, 2);
      assert.ok(result.controls[0].evidence_path);
    }
  }
  assert.equal(run.verdict([]).completed, false);
  await sweepOwnerStates({ run, targets, routedScreens: routes, freshPageFor: factory, evidence, persist: async () => {}, sweep: fastSweep });
  const snapshot = run.snapshot();
  assert.equal(snapshot.expectedStates, 4);
  assert.equal(snapshot.stateObligations.filter(row => row.status === 'passed').length, 4);
  for (const entry of snapshot.stateObligations) {
    assert.ok(entry.sources.some(row => row.path === '/'));
    assert.ok(entry.sources.some(row => row.path === '/deals'));
    assert.ok(entry.result.controls.some(row => row.selector === '#nested' && row.status === 'OBSERVED'), 'same-tab local drawer retained');
    assert.ok(entry.result.controls.every(row => row.state_scope === entry.key));
  }
  const idea = snapshot.stateObligations.find(row => row.target === 'desktop' && row.spec.id === 'tab-ideas');
  const event = snapshot.stateObligations.find(row => row.target === 'desktop' && row.spec.id === 'tab-events');
  assert.notEqual(idea.result.controls.find(row => row.selector === '#drawer').key, event.result.controls.find(row => row.selector === '#drawer').key);
  assert.equal(run.verdict([]).completed, true);
  const again = makeRun({ release, ...snapshot });
  assert.equal(again.pendingStates().length, 0);
  assert.deepEqual(again.snapshot(), snapshot);
  const tampered = structuredClone(snapshot);
  tampered.stateObligations[0].sources[0].evidence_path = '/synthetic/invented.png';
  assert.throws(() => makeRun({ release, ...tampered }), /state obligation/);
});

test('a killed canonical publish leaves pending delegation; resume registers both obligations without replacing source evidence', async t => {
  const output = await mkdtemp(join(tmpdir(), 'doctorcre-owner-kill-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const factory = await browserFixture(t), run = makeRun();
  let pending, delegated;
  const result = await sourceSweep(run, factory, targets[0], routes[0], async partial => {
    await persistSweepReport(output, run, setup);
    if (partial.traversal?.pending_discovery) pending ||= structuredClone(await readSweepCheckpoint(output));
    else if (partial.delegations?.length && !delegated) delegated = structuredClone(run.snapshot());
  });
  assert.ok(pending.screens[0].traversal.pending_discovery);
  assert.equal(result.controls.length, 1);
  // Restore the last commit before delegation. The child really dies after
  // publishing a derived file but before the authoritative controls.json.
  await writeFile(join(output, 'controls.json'), JSON.stringify(pending));
  const incoming = join(output, 'incoming.json');
  await writeFile(incoming, JSON.stringify({ release, ...delegated }));
  const script = join(output, 'kill-publish.mjs');
  const module = new URL('../../scripts/e2e-staging/report.mjs', import.meta.url).href;
  await writeFile(script, "import {readFile,rename} from 'node:fs/promises'; import {writeReport} from " + JSON.stringify(module) + "; const [output,input]=process.argv.slice(2); await writeReport(output,{...JSON.parse(await readFile(input)),publishFile:async(a,b)=>{ await rename(a,b); if(b.endsWith('/coverage.md')) process.kill(process.pid,'SIGKILL'); }});");
  const child = spawn(process.execPath, [script, output, incoming], { stdio: 'ignore' });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  const restored = await readSweepCheckpoint(output);
  assert.deepEqual(restored, pending);
  const resumed = makeRun(restored), oldRow = structuredClone(restored.screens[0].controls[0]);
  const next = await sourceSweep(resumed, factory, targets[0], routes[0]);
  assert.equal(next.controls.length, 1);
  assert.deepEqual(next.controls[0], oldRow);
  const stored = resumed.snapshot();
  assert.equal(stored.stateObligations.filter(row => row.target === 'desktop' && row.sources.length).length, 2);
  assert.equal(stored.screens[0].controls.length, 1);
  await persistSweepReport(output, resumed, setup);
  assert.doesNotThrow(() => makeRun({ release, ...stored }));
});

test('owner failures stay incomplete; child DEAD and interrupted history retain exact allowlist keys', async t => {
  const factory = await browserFixture(t), run = makeRun();
  await sourceSweep(run, factory, targets[0], routes[0]);
  let count = 0;
  await sweepOwnerStates({ run, targets, routedScreens: routes, freshPageFor: factory, evidence, persist: async () => {}, sweep: async options => {
    count++;
    const result = await fastSweep({ ...options, freshPage: async () => {
      const page = await options.freshPage();
      await page.locator('main').evaluate(node => node.insertAdjacentHTML('afterbegin', '<button id="dead">Dead</button>'));
      return page;
    } });
    result.failure = { phase: 'session-preflight', code: 'session-preflight-failed', openers: [] };
    return result;
  } });
  assert.equal(count, 4, 'each failed owner tried only once');
  assert.equal(run.pendingStates().length, 4);
  const dead = run.snapshot().stateObligations.flatMap(entry => entry.result.controls.filter(row => row.status === 'DEAD').map(row => row.key));
  assert.deepEqual(new Set(run.verdict([]).newDeadControls), new Set(dead));
  const resumed = makeRun({ release, ...run.snapshot() });
  await sweepOwnerStates({ run: resumed, targets, routedScreens: routes, freshPageFor: factory, evidence, persist: async () => {}, sweep: fastSweep });
  assert.equal(resumed.pendingStates().length, 0);
  assert.ok(resumed.snapshot().stateObligations.every(entry => entry.history.length === 1));
  const allDead = resumed.verdict([]).newDeadControls;
  assert.ok(dead.every(key => allDead.includes(key)), 'historical exact DEAD keys cannot disappear');
  assert.equal(resumed.verdict(allDead.map(key => ({ key, reason: 'Tracked synthetic failure' }))).newDeadControls.length, 0);
});

test('60 screens and 90 model goals remain required alongside 62 declared state obligations', () => {
  const planned = Array.from({ length: 30 }, (_, i) => ({ name: 'Workspace ' + i, path: i === 0 ? '/calendar' : i === 1 ? '/ideas-events' : '/workspace' + i, surface: 'app' }));
  const run = createSweepRun({ targets, routedScreens: planned });
  assert.equal(run.snapshot().expectedScreens, 60);
  assert.equal(run.snapshot().expectedExplorations, 90);
  assert.equal(run.snapshot().expectedStates, 62);
  assert.equal(declaredStates(['/calendar']).filter(row => row.kind === 'calendar-operation').length, 27);
  assert.equal(run.verdict([]).completed, false);
});

test('owner pending discovery resumes the immutable measured prefix with a new evidence namespace', async t => {
  const factory = await browserFixture(t), run = makeRun();
  await sourceSweep(run, factory, targets[0], routes[0]);
  let interrupted = false;
  await sweepOwnerStates({ run, targets, routedScreens: routes, freshPageFor: factory, evidence, persist: async () => {}, sweep: options =>
    fastSweep({ ...options, checkpoint: async partial => {
      await options.checkpoint(partial);
      if (!interrupted && partial.controls.some(row => row.selector === '#drawer') && partial.traversal.pending_discovery) {
        interrupted = true;
        throw new Error('Synthetic checkpoint interruption');
      }
    } }) });
  const old = run.snapshot().stateObligations.find(entry => entry.result?.failure);
  assert.ok(old.result.traversal.pending_discovery);
  const saved = structuredClone(old);
  const resumed = makeRun({ release, ...run.snapshot() });
  const originalNamespace = run.evidencePaths('/synthetic/output', '/synthetic/private', 'OBSERVED');
  const resumedNamespace = resumed.evidencePaths('/synthetic/output', '/synthetic/private', 'OBSERVED');
  assert.notEqual(originalNamespace.png, resumedNamespace.png);
  await sweepOwnerStates({ run: resumed, targets, routedScreens: routes, freshPageFor: factory, evidence, persist: async () => {}, sweep: fastSweep });
  const current = resumed.snapshot().stateObligations.find(entry => entry.key === saved.key);
  assert.equal(current.status, 'passed');
  assert.equal(current.attempt_id, saved.attempt_id);
  assert.deepEqual(current.result.controls.slice(0, saved.result.controls.length), saved.result.controls);
  assert.ok(!current.history?.length);
  assert.ok(current.result.controls.some(row => row.selector === '#nested'));
  assert.doesNotThrow(() => makeRun({ release, ...resumed.snapshot() }));
});

test('an unknown Calendar query preserves its source evidence and fails coverage before acting on destination controls', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const result = await fastSweep({ target: 'desktop', screen: routes[0], evidence, routedPaths: ['/calendar'],
    freshPage: async () => {
      const page = await browser.newPage();
      await page.route(origin + '/**', route => route.fulfill({ contentType: 'text/html', body: new URL(route.request().url()).pathname === '/'
        ? '<main><a id="unknown" href="/calendar?unknown=synthetic">Calendar</a></main>'
        : '<main><button id="must-not-press" onclick="window.wasPressed=true">Destination</button></main>' }));
      await page.goto(origin); return page;
    } });
  assert.equal(result.failure.phase, 'ownership');
  assert.equal(result.failure.code, 'calendar-query-unclassified');
  assert.equal(result.controls.length, 1);
  assert.equal(result.controls[0].status, 'OBSERVED');
  assert.ok(result.controls[0].evidence_path);
  assert.ok(result.traversal.pending_discovery);
});

test('Calendar preflight failure preserves an existing owner frontier and prevents any owner action', async () => {
  const screen = { name: 'Calendar', surface: 'app', path: '/calendar' };
  const run = createSweepRun({ targets: [targets[0]], routedScreens: [screen] });
  const entry = run.pendingStates().find(row => row.spec.id === 'workspace-month');
  const { canonicalIdentity, identityKey } = await import('../../scripts/e2e-staging/traversal.mjs');
  const action = { identity: canonicalIdentity('synthetic measured owner control'), selector: '#measured', role: 'button', name: 'Measured' };
  const remaining = { identity: canonicalIdentity('synthetic queued owner control'), selector: '#remaining', role: 'button', name: 'Remaining' };
  const result = { ...screen, target: 'desktop', state_scope: entry.key, reached: true, in_progress: true, controls: [{
    ...action, key: 'desktop//calendar/' + identityKey(action.identity), target: 'desktop', path: '/calendar', screen: screen.name,
    openers: [], status: 'OBSERVED', signals: ['main DOM mutation'], evidence_path: '/synthetic/measured.png',
  }], traversal: { schema: 'control-frontier.v1', seen: [action.identity], active: null, queue: [{ openers: [], controls: [remaining] }], destructive: [], pending_discovery: null, known_remaining: 1, max_opener_depth: 0 } };
  run.recordState(entry.key, result);
  const resumed = createSweepRun({ targets: [targets[0]], routedScreens: [screen], prior: { release, ...run.snapshot() } });
  let actions = 0;
  await sweepOwnerStates({ run: resumed, targets: [targets[0]], routedScreens: [screen],
    freshPageFor: () => async () => { throw new Error('Synthetic session unavailable'); }, evidence,
    persist: async () => {}, sweep: async () => { actions++; throw new Error('Must not run'); } });
  const retained = resumed.snapshot().stateObligations.find(row => row.key === entry.key);
  assert.deepEqual(retained.result.controls, result.controls);
  assert.deepEqual(retained.result.traversal, result.traversal);
  assert.equal(actions, 0);
  assert.equal(retained.result.failure.code, 'calendar-inventory-failed');
  assert.equal(resumed.verdict([]).completed, false);
  assert.doesNotThrow(() => createSweepRun({ targets: [targets[0]], routedScreens: [screen], prior: { release, ...resumed.snapshot() } }));
});

test('board desktop and phone delegate Ideas and Calendar to matching app owners, retaining source evidence across checkpoint resume', async t => {
  const crossTargets = [
    { name: 'staging-live', surface: 'app', viewport: { width: 1440, height: 960 } },
    { name: 'staging-live-phone', surface: 'app', viewport: { width: 390, height: 844 } },
    { name: 'staging-live-board', surface: 'board', viewport: { width: 1440, height: 960 } },
    { name: 'staging-live-board-phone', surface: 'board', viewport: { width: 390, height: 844 } },
  ];
  const crossRoutes = [
    { name: 'Board', path: '/control-room/progress', surface: 'board' },
    { name: 'Ideas', path: '/ideas-events', surface: 'app' },
    { name: 'Calendar', path: '/calendar', surface: 'app' },
  ];
  const calendarPath = '/calendar?view=week&d=2028-02-29&day=2028-02-29';
  const boardHTML = '<main><a id="source-events" href="/ideas-events?tab=events">Events</a><a id="source-calendar" href="' + calendarPath + '">Calendar</a></main>';
  const calendarHTML = '<main><button id="drawer" onclick="document.querySelector(\'#panel\').hidden=false">Calendar record drawer</button><section id="panel" hidden><button id="nested" onclick="document.querySelector(\'#result\').textContent=\'changed\'">Record action</button></section><output id="result"></output></main>';
  const browser = await chromium.launch(); t.after(() => browser.close());
  const output = await mkdtemp(join(tmpdir(), 'doctorcre-cross-surface-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const factory = (target, screen, spec) => async () => {
    const page = await browser.newPage({ viewport: target.viewport });
    await page.route(origin + '/**', route => {
      const url = new URL(route.request().url());
      return route.fulfill({ contentType: 'text/html', body: url.pathname === crossRoutes[0].path ? boardHTML
        : url.pathname === '/calendar' ? calendarHTML : fixture(url.pathname, url.searchParams.get('tab')) });
    });
    await page.goto(origin + (spec?.url || screen.path));
    return page;
  };
  let run = createSweepRun({ targets: crossTargets, routedScreens: crossRoutes });
  let interrupted = false;
  const measureBoard = async (target, allowInterruption) => {
    const result = await fastSweep({ freshPage: factory(target, crossRoutes[0]), screen: crossRoutes[0], target: target.name,
      routedPaths: crossRoutes.map(row => row.path), evidence, prior: run.priorScreen(target.name, crossRoutes[0].path),
      checkpoint: async partial => {
        run.record(partial);
        await persistSweepReport(output, run, setup);
        if (allowInterruption && !interrupted && partial.traversal.pending_discovery) {
          interrupted = true; throw new Error('Synthetic stop before cross-surface delegation');
        }
      } });
    run.record(result); await persistSweepReport(output, run, setup);
    return result;
  };
  const partial = await measureBoard(crossTargets[2], true);
  assert.ok(partial.traversal.pending_discovery);
  assert.equal(partial.controls.length, 1);
  const saved = await readSweepCheckpoint(output);
  const prefix = structuredClone(saved.screens.find(row => row.target === crossTargets[2].name).controls);
  run = createSweepRun({ targets: crossTargets, routedScreens: crossRoutes, prior: saved });
  const desktop = await measureBoard(crossTargets[2], false);
  assert.equal(desktop.failure, null);
  assert.deepEqual(desktop.controls.slice(0, prefix.length), prefix);
  assert.equal(desktop.controls.length, 2);
  interrupted = false;
  const phonePartial = await measureBoard(crossTargets[3], true);
  assert.ok(phonePartial.traversal.pending_discovery);
  assert.equal(phonePartial.controls.length, 1);
  const phoneSaved = await readSweepCheckpoint(output);
  const phonePrefix = structuredClone(phoneSaved.screens.find(row => row.target === crossTargets[3].name).controls);
  run = createSweepRun({ targets: crossTargets, routedScreens: crossRoutes, prior: phoneSaved });
  const phone = await measureBoard(crossTargets[3], false);
  assert.equal(phone.failure, null);
  assert.deepEqual(phone.controls.slice(0, phonePrefix.length), phonePrefix);
  assert.equal(phone.controls.length, 2);
  assert.ok([...desktop.controls, ...phone.controls].every(row => row.status === 'OBSERVED' && row.evidence_path));
  const beforeOwners = run.snapshot();
  const delegated = beforeOwners.stateObligations.filter(entry => entry.sources.some(source => source.target.includes('-board')));
  assert.equal(delegated.length, 6, 'both tab owners and the exact Calendar state on each app viewport');
  for (const entry of delegated) {
    const source = entry.sources.find(row => row.target.includes('-board'));
    const ownerName = source.target === 'staging-live-board' ? 'staging-live' : 'staging-live-phone';
    assert.equal(entry.target, ownerName);
    assert.deepEqual(entry.viewport, crossTargets.find(row => row.name === source.target).viewport);
    assert.equal(source.path, crossRoutes[0].path);
    assert.ok(source.key.startsWith(source.target + '/' + source.path + '/'));
    if (entry.spec.owner === '/calendar') assert.equal(entry.spec.url, calendarPath);
  }
  run = createSweepRun({ targets: crossTargets, routedScreens: crossRoutes, prior: await readSweepCheckpoint(output) });
  for (const entry of delegated) {
    const target = crossTargets.find(row => row.name === entry.target), screen = crossRoutes.find(row => row.path === entry.spec.owner);
    const result = await fastSweep({ freshPage: factory(target, screen, entry.spec), target: target.name, screen, identityScope: entry.key,
      routedPaths: crossRoutes.map(row => row.path), evidence, checkpoint: async partial => {
        run.recordState(entry.key, partial); await persistSweepReport(output, run, setup);
      } });
    assert.equal(result.failure, null);
    assert.ok(result.controls.some(row => row.selector === '#nested'));
    run.recordState(entry.key, result);
    await persistSweepReport(output, run, setup);
  }
  const completeOwners = await readSweepCheckpoint(output);
  for (const entry of delegated) {
    const completed = completeOwners.stateObligations.find(row => row.key === entry.key);
    assert.equal(completed.status, 'passed');
    assert.equal(completed.result.target, entry.target);
    assert.ok(completed.result.controls.every(row => row.target === entry.target && row.state_scope === entry.key));
    assert.ok(completed.sources.some(source => source.target.includes('-board')));
  }
  assert.doesNotThrow(() => createSweepRun({ targets: crossTargets, routedScreens: crossRoutes, prior: completeOwners }));
  assert.equal(run.verdict([]).completed, false, 'functional Calendar and full base coverage remain required');
  const wrongViewport = structuredClone(completeOwners);
  const desktopEntry = wrongViewport.stateObligations.find(entry => entry.target === 'staging-live' && entry.sources.some(row => row.target === 'staging-live-board'));
  const phoneBinding = wrongViewport.stateObligations.find(entry => entry.target === 'staging-live-phone' && entry.spec.id === desktopEntry.spec.id)
    .sources.find(row => row.target === 'staging-live-board-phone');
  desktopEntry.sources[desktopEntry.sources.findIndex(row => row.target === 'staging-live-board')] = structuredClone(phoneBinding);
  assert.throws(() => createSweepRun({ targets: crossTargets, routedScreens: crossRoutes, prior: wrongViewport }), /state obligation/);
  const wrongOwner = structuredClone(completeOwners);
  wrongOwner.stateObligations.find(entry => entry.target === 'staging-live' && entry.spec.owner === '/calendar').target = 'staging-live-board';
  assert.throws(() => createSweepRun({ targets: crossTargets, routedScreens: crossRoutes, prior: wrongOwner }), /state obligation/);
  const missing = createSweepRun({ targets: crossTargets.filter(row => row.surface === 'board'), routedScreens: crossRoutes });
  assert.throws(() => missing.record(desktop), /state obligation/);
  const ambiguous = createSweepRun({ targets: [...crossTargets, { ...crossTargets[0], name: 'second-desktop-app' }], routedScreens: crossRoutes });
  assert.throws(() => ambiguous.record(desktop), /state obligation/);
});
