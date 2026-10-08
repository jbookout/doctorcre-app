import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, readFile, rm, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../../test/browser-harness.mjs';
import { CONTROL_SELECTOR, inventory, pressControl, sweepScreen, settledInventory, SweepFailure } from '../../scripts/e2e-staging/controls.mjs';
import { assertStagingURL, readSessionSecret, preflightRequest, SessionPreflightFailure } from '../../scripts/e2e-staging/session.mjs';
import { newDeadControls, explorationEvidence, writeReport } from '../../scripts/e2e-staging/report.mjs';
import { validateTraversal } from '../../scripts/e2e-staging/traversal.mjs';
import { persistSweepReport } from '../../scripts/e2e-staging/sweep.mjs';
import { createSweepRun } from '../../scripts/e2e-staging/resume.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { assertStagingDeployment, waitForStagingRelease } from '../../scripts/e2e-staging/deployment.mjs';

const html = `<main><button id="dead" onclick="this.blur()">Dead</button><button id="live" onclick="document.querySelector('#result').textContent='Changed'">Live</button><button id="disabled" disabled title="Requires a selected record">Disabled</button><button id="drawer" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true'); document.querySelector('#sheet').hidden=false">Open drawer</button><section id="sheet" hidden><button id="nested" onclick="document.querySelector('#result').textContent='Nested'">Nested</button></section><output id="result"></output></main>`;

test('deployment waits for its staging source through edge propagation and refuses persistent mismatches', async () => {
  const source = 'a'.repeat(40);
  let reads = 0;
  const release = await waitForStagingRelease(source, {
    fetchRelease: async () => new Response(JSON.stringify({ environment: 'staging', source_commit: ++reads === 1 ? 'b'.repeat(40) : source })),
    pause: async () => {},
  });
  assert.equal(release.source_commit, source);
  assert.equal(reads, 2);
  for (const environment of ['production', 'staging']) {
    let failedReads = 0;
    await assert.rejects(waitForStagingRelease(source, {
      fetchRelease: async () => { failedReads++; return new Response(JSON.stringify({ environment, source_commit: environment === 'production' ? source : 'b'.repeat(40) })); },
      pause: async () => {},
    }), /bounded propagation/);
    assert.equal(failedReads, 6);
  }
});

test('deployment refuses production bindings, names and routes', () => {
  const config = { env: { staging: { name: 'doctorcre-app-staging', workers_dev: true, routes: [], vars: { APP_ENV: 'staging' }, services: [{ binding: 'CARR', service: 'carr-mcp-staging' }] } } };
  assert.doesNotThrow(() => assertStagingDeployment(config));
  for (const changes of [{ name: 'doctorcre-app' }, { routes: ['app.doctorcre.com/*'] }, { services: [{ binding: 'CARR', service: 'carr-mcp' }] }, { vars: { APP_ENV: 'production' } }]) {
    assert.throws(() => assertStagingDeployment({ env: { staging: { ...config.env.staging, ...changes } } }));
  }
});

test('staging target rejects production, credentials, HTTP and host lookalikes', () => {
  assert.equal(assertStagingURL('https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev/'), 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev');
  for (const url of ['https://app.doctorcre.com', 'https://evil-staging.example', 'http://doctorcre-app-staging.joe-bookout-carr-us.workers.dev', 'https://joe:password@doctorcre-app-staging.joe-bookout-carr-us.workers.dev']) assert.throws(() => assertStagingURL(url));
});

test('secret comes only from a private file, never relaxed permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-private-'));
  const path = join(dir, 'secret');
  await writeFile(path, 'x'.repeat(64), { mode: 0o600 });
  assert.equal(await readSessionSecret(path), 'x'.repeat(64));
  await chmod(path, 0o644);
  await assert.rejects(readSessionSecret(path), /mode 600/);
});

test('DEAD allowlist requires a reason and matches the exact target/screen/control', () => {
  const row = { status: 'DEAD', key: 'desktop/home/dead' };
  assert.deepEqual(newDeadControls([row], []), [row]);
  assert.deepEqual(newDeadControls([row], [{ key: row.key, reason: 'Tracked in synthetic test' }]), []);
  assert.throws(() => newDeadControls([row], [{ key: row.key, reason: '' }]));
  assert.deepEqual(newDeadControls([row], [{ key: 'phone/home/dead', reason: 'Different target' }]), [row]);
});

test('finding screenshots resolve inside the published artifact tree', () => {
  const report = { run: { results: [{ attempts: [{ artifacts: [{ id: 'shot', path: 'screens/a.png' }] }] }], serialGroups: [] } };
  assert.equal(explorationEvidence(report, 'shot', '/tmp/published'), '/tmp/published/artifacts/screens/a.png');
  assert.equal(explorationEvidence(report, 'missing', '/tmp/published'), '/tmp/published/report.json');
  report.run.results[0].attempts[0].artifacts[0].path = '../../escape';
  assert.throws(() => explorationEvidence(report, 'shot', '/tmp/published'), /escape/);
});

test('observable changes and disabled reasons are classified; nested controls are pressed fresh', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html);
  const controls = await inventory(page);
  assert.equal(controls.find(c => c.name === 'Disabled').reason, 'Requires a selected record');
  const dead = await pressControl(page, controls.find(c => c.name === 'Dead'), { waitMs: 50 });
  assert.equal(dead.status, 'OBSERVED');
  await page.setContent(html.replace(' onclick="this.blur()"', ''));
  assert.equal((await pressControl(page, (await inventory(page)).find(c => c.name === 'Dead'), { waitMs: 50 })).status, 'DEAD');
  assert.equal((await pressControl(page, (await inventory(page)).find(c => c.name === 'Live'), { waitMs: 50 })).status, 'OBSERVED');
  await page.close();
  const results = await sweepScreen({
    freshPage: async () => { const next = await browser.newPage(); await next.setContent(html); return next; },
    screen: { path: '/', name: 'Synthetic' }, target: 'test', waitMs: 50,
  });
  assert.ok(results.controls.some(c => c.name === 'Nested' && c.status === 'OBSERVED'));
  assert.ok(results.controls.some(c => c.name === 'Disabled' && c.status === 'DISABLED' && c.reason));
  assert.ok(results.controls.every(c => Array.isArray(c.openers)));
  await browser.close();
});

const detailsFixture = nested => `<main>${nested ? '<details id="outer"><summary id="outerToggle">Actions</summary>' : ''}<details id="park"><summary id="parkToggle">Park</summary><form style="display:grid"><label style="display:grid">Reason<input id="reason"></label><button id="save" type="button" onclick="document.querySelector('#out').textContent='Saved'">Save</button></form></details>${nested ? '</details>' : ''}<output id="out"></output></main>`;

test('closed grid details exclude descendants until their native summaries open', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const nested of [false, true]) {
    const page = await browser.newPage();
    await page.setContent(detailsFixture(nested));
    for (const selector of ['#reason', '#save']) {
      assert.equal(await page.locator(selector).isVisible(), false);
      assert.equal(await page.locator(selector).evaluate(element => element.checkVisibility({ visibilityProperty: true })), false);
    }
    assert.deepEqual((await inventory(page)).map(control => control.selector), [nested ? '#outerToggle' : '#parkToggle']);
    if (nested) {
      await page.locator('#outerToggle').click();
      assert.deepEqual((await inventory(page)).map(control => control.selector), ['#outerToggle', '#parkToggle']);
    }
    await page.locator('#parkToggle').click();
    assert.equal(await page.locator('#reason').isVisible(), true);
    assert.deepEqual((await inventory(page)).map(control => control.selector), [...(nested ? ['#outerToggle'] : []), '#parkToggle', '#reason', '#save']);
    await page.close();
  }
});

test('native details replay their summaries before pressing grid form descendants', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const nested of [false, true]) {
    const result = await sweepScreen({
      freshPage: async () => { const page = await browser.newPage(); await page.setContent(detailsFixture(nested)); return page; },
      screen: { path: '/', name: 'Native details' }, target: 'test', waitMs: 20,
    });
    assert.equal(result.failure, null);
    assert.equal(result.exhausted, false);
    assert.ok(result.controls.every(control => control.status === 'OBSERVED'));
    for (const selector of ['#reason', '#save']) {
      const rows = result.controls.filter(control => control.selector === selector);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].openers, [...(nested ? ['Actions'] : []), 'Park']);
    }
    for (const selector of [...(nested ? ['#outerToggle'] : []), '#parkToggle']) {
      assert.equal(result.controls.filter(control => control.selector === selector).length, 2, 'both disclosure states are pressed');
    }
  }
});

test('inventory excludes hidden inert collapsed and zero-size controls', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main><button id="ready">Ready</button><button hidden>Hidden</button><section hidden><button>Hidden parent</button></section><section inert><button>Inert</button></section><button style="visibility:hidden">Invisible</button><button style="visibility:collapse">Collapsed</button><button style="width:0;height:0;padding:0;border:0">Zero size</button></main>');
  assert.deepEqual((await inventory(page)).map(control => control.selector), ['#ready']);
});

test('removed controls finish within the observation window and exclude delayed signals', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(400);
  await page.route('https://synthetic.test/**', route => route.fulfill({ status: 200, body: 'Synthetic response' }));
  await page.setContent(`<header><button id="gone" value="original" onfocusin="event.stopPropagation()" onfocusout="event.stopPropagation()" onclick="this.remove();setTimeout(()=>{document.querySelector('#out').textContent='Late';document.querySelector('#later').focus();document.querySelector('#later').setAttribute('aria-checked','true');fetch('https://synthetic.test/late').catch(()=>{})},150)">Remove quietly</button><input id="later"></header><main><output id="out"></output></main>`);
  const control = (await inventory(page)).find(control => control.selector === '#gone');
  const started = performance.now();
  const result = await pressControl(page, control, { waitMs: 50 });
  const elapsed = performance.now() - started;
  assert.equal(result.status, 'DEAD');
  assert.deepEqual(result.signals, []);
  assert.ok(elapsed < 300, `Removed control took ${elapsed}ms`);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#out').textContent(), 'Late');
  assert.deepEqual(await page.evaluate(() => ({ mutations: window.__controlObservation.mutations, focus: window.__controlObservation.focus, aria: window.__controlObservation.aria })), { mutations: 0, focus: 0, aria: 0 });
});

test('removed and replaced controls do not await or invent a replacement form value', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const change of ["this.remove()", "this.outerHTML='<input id=action value=replacement>'"]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(400);
    await page.setContent(`<header><button id="action" value="original" onfocusin="event.stopPropagation()" onfocusout="event.stopPropagation()" onclick="${change}">Change target</button></header><main>Unchanged</main>`);
    const started = performance.now();
    const result = await pressControl(page, (await inventory(page)).find(control => control.selector === '#action'), { waitMs: 20 });
    const elapsed = performance.now() - started;
    assert.equal(result.status, 'DEAD');
    assert.deepEqual(result.signals, []);
    assert.ok(elapsed < 300, `Changed control took ${elapsed}ms`);
    await page.close();
  }
});

test('the pinned explorer runs with a forty-step goal budget', async () => {
  const { explorer40 } = await import('../../scripts/e2e-staging/explorer.mjs');
  const explore = await explorer40();
  assert.equal(typeof explore, 'function');
  const module = await import('../../node_modules/e2e/dist/explore/index.js');
  assert.equal(module.STEP_BOUNDS.max, 40);
});

test('both explorers and sweep block production egress at the browser context', async () => {
  const { stagingRequestAllowed, stagingWeb, installStagingGuard } = await import('../../scripts/e2e-staging/engine.mjs');
  assert.equal(stagingRequestAllowed(new URL('https://app.doctorcre.com/mcp')), false);
  assert.equal(stagingRequestAllowed(new URL('https://reports.doctorcre.com/share')), false);
  assert.equal(stagingRequestAllowed(new URL('https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev/mcp')), true);
  assert.equal(stagingWeb({ viewport: { width: 390, height: 844 } }).name, 'web');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await installStagingGuard(page.context());
  await assert.rejects(page.goto('https://reports.doctorcre.com/share'), /ERR_FAILED|ERR_ABORTED/);
  await browser.close();
});

test('shared controls are swept again in each discovered drawer state', async () => {
  const browser = await chromium.launch();
  const changed = `<main><button id="open" onclick="document.querySelector('#done').hidden=false;document.querySelector('#action').onclick=null">Change state</button><button id="action" onclick="document.querySelector('#out').textContent='Live'">Action</button><button id="done" hidden onclick="document.querySelector('#out').textContent='Done'">New action</button><output id="out"></output></main>`;
  const result = await sweepScreen({ freshPage: async () => { const page = await browser.newPage(); await page.setContent(changed); return page; }, screen: { path: '/', name: 'States' }, target: 'test', waitMs: 20 });
  assert.ok(result.controls.some(control => control.name === 'Action' && control.status === 'DEAD' && control.openers.includes('Change state')));
  await browser.close();
});

test('fresh opener replay waits for delayed async nested drawers without a busy attribute', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const outer = `<button id="nested" onclick="document.querySelector('#inner').hidden=false;document.querySelector('#inner').textContent='Updating';fetch('https://synthetic.test/inner').then(response=>response.text()).then(html=>document.querySelector('#inner').innerHTML=html)">Open nested drawer</button><section id="inner" class="drawer" aria-label="Nested drawer" hidden></section>`;
  const inner = `<button id="loaded" onclick="document.querySelector('#out').textContent='Loaded action changed'">Loaded action</button>`;
  const html = `<main><button id="open" onclick="document.querySelector('#outer').hidden=false;document.querySelector('#outer').textContent='Updating';fetch('https://synthetic.test/outer').then(response=>response.text()).then(html=>document.querySelector('#outer').innerHTML=html)">Open drawer</button><section id="outer" class="drawer" aria-label="Outer drawer" hidden></section><output id="out"></output></main>`;
  const result = await sweepScreen({
    freshPage: async () => {
      const page = await browser.newPage();
      await page.route('https://synthetic.test/**', async route => {
        await new Promise(resolve => setTimeout(resolve, 100));
        await route.fulfill({ status: 200, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: route.request().url().endsWith('/outer') ? outer : inner });
      });
      await page.setContent(html);
      return page;
    },
    screen: { path: '/', name: 'Async drawers' }, target: 'test', waitMs: 20, limit: 20,
  });
  assert.equal(result.exhausted, false);
  assert.deepEqual(result.controls.filter(control => control.selector === '#nested').map(control => control.status), ['OBSERVED']);
  assert.ok(result.controls.some(control => control.selector === '#nested' && control.status === 'OBSERVED' && control.openers.includes('Open drawer')));
  assert.ok(result.controls.some(control => control.selector === '#loaded' && control.status === 'OBSERVED' && control.openers.includes('Open nested drawer')));
  assert.ok(result.controls.every(control => !['ERROR','UNREACHABLE'].includes(control.status)));
});

test('phase failures retain accumulated presses and evidence without duplicate controls', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const ordinary = `<main><button id="first" onclick="document.querySelector('#out').textContent='First changed'">First action</button><button id="second" onclick="document.querySelector('#out').textContent='Second changed'">Second action</button><output id="out"></output></main>`;
  const drawer = `<main><button id="open" onclick="document.querySelector('#drawer').hidden=false">Open drawer</button><section id="drawer" class="drawer" aria-label="Synthetic drawer" hidden><button id="nested">Nested action</button></section></main>`;
  for (const scenario of ['fresh-page', 'replay', 'discovery', 'evidence', 'cleanup', 'evidence+cleanup']) await t.test(scenario, async () => {
    let freshCalls = 0;
    const captured = [];
    const result = await sweepScreen({
      freshPage: async () => {
        const ordinal = ++freshCalls;
        if (scenario === 'fresh-page' && ordinal === 3) throw new Error('Synthetic failure do-not-log-canary');
        const page = await browser.newPage();
        await page.setContent(scenario === 'replay' ? ordinal === 3 ? '<main><button id="other">Still loaded</button></main>' : drawer : ordinary);
        const inventoryFailure = scenario === 'discovery' && ordinal === 2;
        const cleanupFailure = scenario === 'cleanup' && ordinal === 2 || scenario === 'evidence+cleanup' && ordinal === 3;
        if (!inventoryFailure && !cleanupFailure) return page;
        return new Proxy(page, {
          get(target, key) {
            if (inventoryFailure && key === 'locator') return selector => selector === CONTROL_SELECTOR ? { evaluateAll: async () => { throw new Error('Synthetic failure do-not-log-canary'); } } : target.locator(selector);
            if (cleanupFailure && key === 'context') return () => {
              const context = target.context();
              return { close: async () => { await context.close(); throw new Error('Synthetic failure do-not-log-canary'); } };
            };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      screen: { path: '/', name: 'Synthetic phases' }, target: 'test', waitMs: 10, limit: 10,
      evidence: async (_page, row) => {
        if (scenario.startsWith('evidence') && captured.length === 1) throw new Error('Synthetic failure do-not-log-canary');
        const path = `synthetic-${captured.length + 1}.png`;
        captured.push({ selector: row.selector, key: row.key, path });
        return path;
      },
    });
    assert.equal(result.reached, true);
    assert.equal(result.failure?.phase, scenario === 'evidence+cleanup' ? 'evidence' : scenario);
    assert.equal(typeof result.failure.code, 'string');
    const first = result.controls.find(row => row.key === captured[0].key);
    assert.equal(first.status, 'OBSERVED');
    assert.equal(first.evidence_path, captured[0].path);
    assert.equal(result.controls.filter(row => row.key === captured[0].key).length, 1);
    assert.equal(new Set(result.controls.map(row => row.key)).size, result.controls.length);
    if (scenario.startsWith('evidence')) assert.deepEqual(result.controls.map(row => row.status), ['OBSERVED', 'OBSERVED']);
    assert.doesNotMatch(JSON.stringify(result), /do-not-log-canary/);
  });
});

test('fresh-page source phases stay bounded and are not inferred from exception text', async () => {
  for (const [phase, code] of [['session-preflight', 'session-preflight-failed'], ['session-preflight', 'source-pair-changed'], ['context', 'context-creation-failed'], ['navigation', 'navigation-failed'], ['load', 'network-idle-failed'], ['tracing', 'tracing-start-failed']]) {
    const error = new SweepFailure(phase, code);
    error.message = 'Synthetic exception do-not-log-canary';
    const result = await sweepScreen({ freshPage: async () => { throw error; }, screen: { path: '/', name: 'Synthetic phases' }, target: 'test' });
    assert.equal(result.reached, false);
    assert.deepEqual(result.controls, []);
    assert.deepEqual(result.failure, { phase, code, openers: [] });
    assert.doesNotMatch(JSON.stringify(result), /do-not-log-canary/);
  }
});

test('coverage names the failure phase while preserving completed press counts', async () => {
  const output = await mkdtemp(join(tmpdir(), 'staging-phase-report-'));
  try {
    const findings = await writeReport(output, { expectedScreens: 2, screens: [{
      target: 'test', path: '/synthetic', name: 'Synthetic phases', surface: 'app', reached: true,
      controls: [{ key: 'synthetic-first', status: 'OBSERVED', evidence_path: 'synthetic-first.png' }],
      failure: { phase: 'discovery', code: 'inventory-failed' },
    }] });
    assert.equal(findings.length, 1);
    assert.deepEqual(Object.keys(findings[0]).sort(), ['actual', 'evidence_path', 'expected', 'id', 'kind', 'screen', 'severity', 'source', 'steps', 'surface', 'suspected_area', 'title']);
    assert.match(findings[0].title, /Automation infrastructure failure/);
    assert.match(findings[0].suspected_area, /scripts\/e2e-staging/);
    assert.equal(findings[0].evidence_path, 'synthetic-first.png');
    const coverage = await readFile(join(output, 'coverage.md'), 'utf8');
    assert.match(coverage, /1\/2 screens reached; 1 controls enumerated; 1 pressed/);
    assert.match(coverage, /discovery: inventory-failed/);
    const published = JSON.parse(await readFile(join(output, 'controls.json'), 'utf8')).screens[0];
    assert.equal(published.controls[0].evidence_path, 'synthetic-first.png');
    assert.deepEqual(published.failure, { phase: 'discovery', code: 'inventory-failed' });
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('pressed view buttons retest shared controls in the selected workspace', async () => {
  const browser = await chromium.launch();
  const html = `<main><button id="viewEverything" aria-pressed="false" onclick="this.setAttribute('aria-pressed','true');document.querySelector('#action').onclick=null">Other view</button><button id="action" onclick="document.querySelector('#out').textContent='Live'">Action</button><output id="out"></output></main>`;
  const result = await sweepScreen({ freshPage: async () => { const page = await browser.newPage(); await page.setContent(html); return page; }, screen: { path: '/', name: 'Views' }, target: 'test', waitMs: 20 });
  assert.ok(result.controls.some(control => control.name === 'Action' && control.status === 'DEAD' && control.openers.includes('Other view')));
  await browser.close();
});

test('independent pressed preferences do not multiply workspace states', async () => {
  const browser = await chromium.launch();
  const html = `<main>${Array.from({ length: 5 }, (_, i) => `<button id="preference${i}" aria-pressed="false" onclick="this.setAttribute('aria-pressed',String(this.getAttribute('aria-pressed')!=='true'))">Preference ${i}</button>`).join('')}</main>`;
  const result = await sweepScreen({ freshPage: async () => { const page = await browser.newPage(); await page.setContent(html); return page; }, screen: { path: '/', name: 'Preferences' }, target: 'test', waitMs: 20, limit: 40 });
  assert.equal(result.exhausted, false);
  assert.equal(result.controls.length, 5);
  await browser.close();
});

test('independent menus do not repeat unrelated controls and both disclosure states are covered', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const count of [2, 3]) {
    const html = `<header><button id="global" onclick="document.querySelector('#out').textContent='Global changed'">Global action</button></header><main>${Array.from({ length: count }, (_, i) => `<button id="open${i}" aria-expanded="false" aria-controls="menu${i}" onclick="const menu=document.querySelector('#menu${i}');menu.hidden=!menu.hidden;this.setAttribute('aria-expanded',String(!menu.hidden))">Menu ${i}</button><section id="menu${i}" role="menu" aria-label="Menu ${i} actions" hidden><button id="nested${i}" onclick="document.querySelector('#out').textContent='Nested ${i}'">Nested ${i}</button></section>`).join('')}<output id="out"></output></main>`;
    const result = await sweepScreen({ freshPage: async () => { const page = await browser.newPage(); await page.setContent(html); return page; }, screen: { path: '/', name: 'Menus' }, target: 'test', waitMs: 20, limit: 100 });
    assert.equal(result.exhausted, false);
    assert.equal(result.controls.length, count * 3 + 1);
    assert.equal(result.controls.filter(control => control.selector === '#global').length, 1);
    for (let i = 0; i < count; i++) {
      assert.equal(result.controls.filter(control => control.selector === `#nested${i}`).length, 1);
      assert.equal(result.controls.filter(control => control.selector === `#open${i}`).length, 2);
    }
    assert.ok(result.controls.every(control => control.status === 'OBSERVED'));
  }
});

test('layout-owned lease tabs retest shared controls in both views', async () => {
  const browser = await chromium.launch();
  const html = `<main><div id="appTabsSlot"><button data-lease-view="timeline" aria-pressed="true" onclick="document.querySelector('#refresh').onclick=()=>document.querySelector('#out').textContent='Live';this.setAttribute('aria-pressed','true');this.nextElementSibling.setAttribute('aria-pressed','false')">Timeline</button><button data-lease-view="gaps" aria-pressed="false" onclick="document.querySelector('#refresh').onclick=null;this.setAttribute('aria-pressed','true');this.previousElementSibling.setAttribute('aria-pressed','false')">Missing dates</button></div><button id="refresh" onclick="document.querySelector('#out').textContent='Live'">Refresh leases</button><output id="out"></output></main>`;
  const result = await sweepScreen({ freshPage: async () => { const page = await browser.newPage(); await page.setContent(html); return page; }, screen: { path: '/', name: 'Leases' }, target: 'test', waitMs: 20 });
  assert.ok(result.controls.some(control => control.name === 'Refresh leases' && control.status === 'DEAD' && control.openers.includes('Missing dates')));
  await browser.close();
});

test('record drawers with shared controls are swept under each accessible title', async () => {
  const browser = await chromium.launch();
  const html = `<main><button id="one" onclick="document.querySelector('#title').textContent='Record one';document.querySelector('#action').onclick=()=>document.querySelector('#out').textContent='Live';document.querySelector('dialog').showModal()">Open record one</button><button id="two" onclick="document.querySelector('#title').textContent='Record two';document.querySelector('#action').onclick=null;document.querySelector('dialog').showModal()">Open record two</button><dialog aria-labelledby="title"><h2 id="title"></h2><button id="action">Shared action</button><output id="out"></output></dialog></main>`;
  const result = await sweepScreen({ freshPage: async () => { const page = await browser.newPage(); await page.setContent(html); return page; }, screen: { path: '/', name: 'Records' }, target: 'test', waitMs: 20 });
  assert.ok(result.controls.some(control => control.name === 'Shared action' && control.status === 'OBSERVED' && control.openers.includes('Open record one')));
  assert.ok(result.controls.some(control => control.name === 'Shared action' && control.status === 'DEAD' && control.openers.includes('Open record two')));
  assert.ok(result.controls.every(control => !['ERROR','UNREACHABLE'].includes(control.status)));
  await browser.close();
});

test('reused record menus retest shared controls under each accessible label', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const labelledBy of [false, true]) {
    const label = text => labelledBy ? `document.querySelector('#menuTitle').textContent='${text}'` : `document.querySelector('#menu').setAttribute('aria-label','${text}')`;
    const html = `<header><button id="global" onclick="document.querySelector('#out').textContent='Global changed'">Global action</button></header><main><button id="one" onclick="${label('Record one actions')};document.querySelector('#action').onclick=()=>document.querySelector('#out').textContent='Live';document.querySelector('#menu').hidden=false">Open record one</button><button id="two" onclick="${label('Record two actions')};document.querySelector('#action').onclick=null;document.querySelector('#menu').hidden=false">Open record two</button><section id="menu" role="menu" ${labelledBy ? 'aria-labelledby="menuTitle"' : 'aria-label="Record actions"'} hidden><h2 id="menuTitle">Record actions</h2><button id="action" role="menuitem">Shared action</button></section><output id="out"></output></main>`;
    const result = await sweepScreen({ freshPage: async () => { const page = await browser.newPage(); await page.setContent(html); return page; }, screen: { path: '/', name: 'Record menus' }, target: 'test', waitMs: 20, limit: 20 });
    assert.equal(result.exhausted, false);
    assert.ok(result.controls.some(control => control.name === 'Shared action' && control.status === 'OBSERVED' && control.openers.includes('Open record one')));
    assert.ok(result.controls.some(control => control.name === 'Shared action' && control.status === 'DEAD' && control.openers.includes('Open record two')));
    assert.equal(result.controls.filter(control => control.selector === '#action').length, 2);
    assert.equal(result.controls.filter(control => control.selector === '#global').length, 1);
    assert.ok(result.controls.every(control => !['ERROR','UNREACHABLE'].includes(control.status)));
  }
});

test('all select options and their newly revealed controls are swept', async () => {
  const browser = await chromium.launch();
  const html = `<main><select id="choices" onchange="document.querySelector('#out').textContent=this.value;if(this.value==='two')document.querySelector('#hidden').hidden=false"><option value="zero">Zero</option><option value="one">One</option><option value="two">Two</option></select><button id="hidden" hidden>Dead hidden</button><output id="out"></output></main>`;
  const result = await sweepScreen({ freshPage: async () => { const page = await browser.newPage(); await page.setContent(html); return page; }, screen: { path: '/', name: 'Options' }, target: 'test', waitMs: 20 });
  assert.ok(result.controls.some(control => control.name.includes('Two')));
  assert.ok(result.controls.some(control => control.name === 'Dead hidden' && control.status === 'DEAD'));
  await browser.close();
});

test('range input changes without a fill error and independent filters do not multiply states', async () => {
  const browser = await chromium.launch();
  const html = `<main><input id="range" type="range" value="20" oninput="document.querySelector('#out').textContent=this.value"><select id="first"><option>A</option><option>B</option><option>C</option></select><select id="second"><option>A</option><option>B</option><option>C</option></select><output id="out"></output></main>`;
  const result = await sweepScreen({ freshPage: async () => { const page = await browser.newPage(); await page.setContent(html); return page; }, screen: { path: '/', name: 'Filters' }, target: 'test', waitMs: 20 });
  assert.equal(result.controls.find(control => control.selector === '#range').status, 'OBSERVED');
  assert.equal(result.controls.length, 7);
  await browser.close();
});

test('loading completion after a control snapshot cannot settle that stale snapshot', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main aria-busy="true"><button>Loading</button></main>');
  let snapshots = 0;
  const transitioningPage = {
    locator(selector) {
      const locator = page.locator(selector);
      if (selector !== CONTROL_SELECTOR) return locator;
      return {
        async evaluateAll(...args) {
          const result = await locator.evaluateAll(...args);
          if (++snapshots === 2) await page.evaluate(() => {
            document.querySelector('main').innerHTML = '<button>Ready</button>';
            document.querySelector('main').removeAttribute('aria-busy');
          });
          return result;
        },
      };
    },
    waitForTimeout: milliseconds => page.waitForTimeout(milliseconds),
  };
  assert.equal((await settledInventory(transitioningPage, { stableMs: 50, timeoutMs: 1500 }))[0].name, 'Ready');
  assert.ok(snapshots >= 2);
});

test('settling retains visible busy semantics for zero-size and display-contents indicators', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main><button>Ready</button></main><div aria-busy="true" hidden>Hidden</div><div aria-busy="true" style="width:0;height:0;overflow:hidden"></div>');
  assert.equal((await settledInventory(page, { stableMs: 0, timeoutMs: 500 }))[0].name, 'Ready');
  await page.setContent('<main aria-busy="true" style="display:contents"><button>Loading</button></main>');
  await assert.rejects(settledInventory(page, { stableMs: 0, timeoutMs: 150 }), /completeness/);
  await page.evaluate(() => {
    document.querySelector('main').innerHTML = '<button>Ready</button>';
    document.querySelector('main').removeAttribute('aria-busy');
  });
  assert.equal((await settledInventory(page, { stableMs: 0, timeoutMs: 500 }))[0].name, 'Ready');
});

test('closed details busy text follows native visibility through display-contents wrappers', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  for (const nested of [false, true]) {
    await page.setContent(`<main><button>Ready</button><details><summary id="parkToggle">Park</summary>${nested ? '<span style="display:contents"><span style="display:contents">' : ''}<span id="busy" aria-busy="true" style="display:contents">Loading</span>${nested ? '</span></span>' : ''}</details><span aria-busy="true" style="display:contents;visibility:hidden">Hidden</span><span aria-busy="true" style="display:contents;visibility:collapse">Collapsed</span></main>`);
    assert.equal((await settledInventory(page, { stableMs: 20, timeoutMs: 400 }))[0].name, 'Ready');
    await page.locator('#parkToggle').click();
    await assert.rejects(settledInventory(page, { stableMs: 20, timeoutMs: 150 }), /completeness/);
    await page.locator('#busy').evaluate(element => element.remove());
    assert.equal((await settledInventory(page, { stableMs: 20, timeoutMs: 400 }))[0].name, 'Ready');
  }
  await page.setContent('<main><button>Ready</button><details><summary><span id="busy" aria-busy="true" style="display:contents">Loading</span></summary><p>Closed content</p></details></main>');
  await assert.rejects(settledInventory(page, { stableMs: 20, timeoutMs: 150 }), /completeness/);
  await page.locator('#busy').evaluate(element => element.remove());
  assert.equal((await settledInventory(page, { stableMs: 20, timeoutMs: 400 }))[0].name, 'Ready');
});

test('late controls settle before enumeration and empty screens fail completeness', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<main aria-busy="true"><button>Loading</button></main>');
  const timer = setTimeout(() => page.evaluate(() => { document.querySelector('main').innerHTML = '<button>Ready</button>'; document.querySelector('main').removeAttribute('aria-busy'); }), 250);
  assert.equal((await settledInventory(page, { stableMs: 100, timeoutMs: 1500 }))[0].name, 'Ready');
  clearTimeout(timer);
  await page.setContent('<main>Empty</main>');
  await assert.rejects(settledInventory(page, { stableMs: 100, timeoutMs: 250 }), /completeness/);
  await browser.close();
});

test('share credentials are masked from pixels under the deployed CSP', async () => {
  const { installStagingGuard } = await import('../../scripts/e2e-staging/engine.mjs');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await installStagingGuard(page.context());
  await page.goto('about:blank');
  await page.setContent('<meta http-equiv="Content-Security-Policy" content="style-src \'self\'"><main><input id="share-url" value="synthetic-grant"></main>');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#share-url')).opacity === '0');
  assert.equal(await page.locator('#share-url').inputValue(), 'synthetic-grant');
  await browser.close();
});


async function captureControlEvidence(t) {
  const root = await mkdtemp(join(tmpdir(), 'staging-control-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let number = 0;
  return async page => {
    const path = join(root, String(++number).padStart(5, '0') + '.png');
    await page.screenshot({ path });
    return path;
  };
}
async function assertCapturedPNGs(controls) {
  for (const row of controls) {
    assert.ok(row.evidence_path, 'Completed fixture control requires captured evidence');
    const bytes = await readFile(row.evidence_path);
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
}


test('inventory contexts retire before fresh measurements without losing readiness discovery or evidence', async t => {
  const capture = await captureControlEvidence(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const pages = [];
  const fixture = "<main aria-busy=\"true\"><button id=\"first\" onclick=\"document.querySelector('#out').textContent='First changed'\">First action</button><button id=\"open\" onclick=\"document.querySelector('#panel').showModal()\">Open drawer</button><button id=\"disabled\" disabled title=\"Requires a selected record\">Disabled</button><output id=\"out\"></output></main><dialog id=\"panel\" aria-label=\"Synthetic drawer\"><button id=\"nested\" onclick=\"document.querySelector('#nestedOut').textContent='Nested changed'\">Nested action</button><button id=\"close\" onclick=\"document.querySelector('#panel').close()\">Close drawer</button><output id=\"nestedOut\"></output></dialog><script>setTimeout(() => document.querySelector('main').removeAttribute('aria-busy'), 35)</script>";
  const result = await sweepScreen({
    screen: { name: 'Synthetic inventory lifetime', path: '/', surface: 'app' }, target: 'desktop', waitMs: 20,
    freshPage: async () => {
      assert.ok(pages.every(page => page.isClosed()), 'Previous inventory and measurement contexts must be retired');
      const page = await browser.newPage();
      pages.push(page);
      await page.setContent(fixture);
      await page.waitForLoadState('networkidle', { timeout: 30_000 });
      await page.context().tracing.start({ screenshots: true, snapshots: true, sources: false });
      return page;
    },
    evidence: async page => {
      assert.equal(await page.locator('main').getAttribute('aria-busy'), null, 'Keep full fresh-page readiness');
      const path = await capture(page);
      await page.context().tracing.stop({ path: path.replace(/\.png$/, '.zip') });
      return path;
    },
  });
  assert.equal(result.failure, null);
  assert.equal(result.exhausted, false);
  assert.equal(result.in_progress, undefined);
  assert.deepEqual(result.controls.map(row => [row.selector, row.status]), [
    ['#first', 'OBSERVED'], ['#open', 'OBSERVED'], ['#disabled', 'DISABLED'],
    ['#nested', 'OBSERVED'], ['#close', 'OBSERVED'],
  ]);
  assert.equal(result.controls.find(row => row.selector === '#disabled').reason, 'Requires a selected record');
  assert.deepEqual(result.controls.find(row => row.selector === '#nested').openers, ['Open drawer']);
  assert.equal(new Set(result.controls.map(row => row.key)).size, 5);
  assert.ok(pages.every(page => page.isClosed()));
  await assertCapturedPNGs(result.controls);
  for (const row of result.controls) {
    const trace = await readFile(row.evidence_path.replace(/\.png$/, '.zip'));
    assert.deepEqual(trace.subarray(0, 4), Buffer.from([80, 75, 3, 4]));
  }
});

test('inventory context close failure stops presses and preserves the complete resumable frontier', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  let freshCalls = 0, closeCalls = 0;
  const result = await sweepScreen({
    screen: { name: 'Synthetic inventory cleanup', path: '/', surface: 'app' }, target: 'desktop', waitMs: 20,
    freshPage: async () => {
      const ordinal = ++freshCalls;
      const page = await browser.newPage();
      await page.setContent('<main><button id="first">First action</button><button id="second">Second action</button></main>');
      if (ordinal !== 1) return page;
      return new Proxy(page, {
        get(target, key) {
          if (key === 'context') return () => ({
            close: async () => {
              if (++closeCalls === 1) throw new Error('private inventory close canary');
              await target.context().close();
            },
          });
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });
  assert.equal(freshCalls, 1, 'No measurement page or press follows a failed inventory close');
  assert.equal(closeCalls, 2, 'Final cleanup retries the still-owned inventory context');
  assert.deepEqual(result.controls, []);
  assert.deepEqual(result.failure, { phase: 'cleanup', code: 'context-close-failed', openers: [] });
  const frontier = validateTraversal(result);
  assert.equal(frontier.known_remaining, 2);
  assert.deepEqual(frontier.active.controls.map(row => row.selector), ['#first', '#second']);
  assert.deepEqual(frontier.seen, []);
  assert.equal(frontier.pending_discovery, null);
  assert.doesNotMatch(JSON.stringify(result), /private inventory close canary/);
});

test('killing an owned browser sweep after one control preserves durable incomplete evidence', async t => {
  const evidence = await captureControlEvidence(t);
  const output = await mkdtemp(join(tmpdir(), 'staging-killed-screen-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
  const targets = [{ name: 'desktop', surface: 'app' }];
  const routedScreens = [{ name: 'Synthetic', path: '/', surface: 'app' }];
  const source = [
    'import { chromium } from ' + JSON.stringify(new URL('../../test/browser-harness.mjs', import.meta.url).href) + ';',
    'import { sweepScreen } from ' + JSON.stringify(new URL('../../scripts/e2e-staging/controls.mjs', import.meta.url).href) + ';',
    'import { createSweepRun } from ' + JSON.stringify(new URL('../../scripts/e2e-staging/resume.mjs', import.meta.url).href) + ';',
    'import { persistSweepReport } from ' + JSON.stringify(new URL('../../scripts/e2e-staging/sweep.mjs', import.meta.url).href) + ';',
    'const output = ' + JSON.stringify(output) + ', release = ' + JSON.stringify(release) + ';',
    'const targets = ' + JSON.stringify(targets) + ', routedScreens = ' + JSON.stringify(routedScreens) + ';',
    'const browser = await chromium.launch();',
    'process.on("SIGTERM", async () => { await browser.close(); process.exit(1); });',
    'const run = createSweepRun({ targets, routedScreens });',
    'await sweepScreen({ screen: routedScreens[0], target: "desktop", waitMs: 20,',
    'freshPage: async () => { const page = await browser.newPage(); await page.setContent("<main><button id=dead>Dead</button><button id=later>Later</button></main>"); return page; },',
    'evidence: async page => { const path = output + "/synthetic.png"; await page.screenshot({path}); return path; },',
    'checkpoint: async partial => {',
    'run.record(partial); await persistSweepReport(output, run, { release, complete: true, findings: [], needs_restore: [] });',
    // Close only this fixture browser before SIGKILL so the regression leaks no browser processes.
    'await browser.close(); process.send({ durable: true }); setInterval(() => {}, 1000); await new Promise(() => {});',
    '} });',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Fixture checkpoint deadline: ' + stderr)); }, 20_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Fixture exited before checkpoint: ' + code + ' ' + stderr)); });
    child.once('message', value => { clearTimeout(timer); assert.equal(value.durable, true); resolve(); });
  });
  const stopped = once(child, 'exit');
  child.kill('SIGKILL');
  assert.deepEqual(await stopped, [null, 'SIGKILL']);
  const checkpoint = JSON.parse(await readFile(join(output, 'controls.json'), 'utf8'));
  assert.equal(checkpoint.screens[0].in_progress, true);
  assert.equal(checkpoint.screens[0].controls.length, 1);
  const row = checkpoint.screens[0].controls[0];
  assert.equal(row.status, 'DEAD');
  assert.equal(row.selector, '#dead');
  assert.ok((await readFile(row.evidence_path)).length > 0);
  assert.match(await readFile(join(output, 'coverage.md'), 'utf8'), /In progress; incomplete/);
  assert.equal(JSON.parse(await readFile(join(output, 'findings.json'), 'utf8'))[0].evidence_path, row.evidence_path);
  const resumed = createSweepRun({ targets, routedScreens, prior: checkpoint });
  assert.equal(resumed.pending.length, 1);
  assert.equal(resumed.verdict([]).completed, false);
  assert.deepEqual(resumed.verdict([]).newDeadControls, [row.key]);
  assert.throws(() => resumed.record({ ...checkpoint.screens[0], controls: [{ ...row, status: 'OBSERVED' }] }), /Measured control evidence/);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const continued = await sweepScreen({ screen: routedScreens[0], target: 'desktop', prior: checkpoint.screens[0], waitMs: 20, evidence,
    freshPage: async () => { const page = await browser.newPage(); await page.setContent('<main><button id=dead>Dead</button><button id=later>Later</button></main>'); return page; },
  });
  assert.equal(continued.controls.length, 2);
  assert.equal(continued.controls.filter(control => control.selector === '#dead').length, 1);
  assert.equal(continued.controls[0].status, 'DEAD');
  await assertCapturedPNGs(continued.controls);
  resumed.record(continued);
  assert.equal(resumed.verdict([]).completed, true);
  assert.equal(resumed.snapshot().history.length, 0);
  assert.equal(resumed.snapshot().screens[0].attempt_id, checkpoint.screens[0].attempt_id);
  assert.deepEqual(resumed.verdict([]).newDeadControls, continued.controls.map(control => control.key));
});

test('checkpoint failure stops new presses and reports a bounded infrastructure failure', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  let writes = 0;
  const result = await sweepScreen({
    screen: { name: 'Synthetic', path: '/', surface: 'app' }, target: 'desktop', waitMs: 20,
    freshPage: async () => { const page = await browser.newPage(); await page.setContent('<main><button id=first>First</button><button id=second>Second</button></main>'); return page; },
    checkpoint: async () => { writes++; throw new Error('private credential canary'); },
  });
  assert.equal(writes, 1);
  assert.equal(result.controls.length, 1);
  assert.equal(result.controls[0].selector, '#first');
  assert.deepEqual(result.failure, { phase: 'checkpoint', code: 'checkpoint-write-failed', openers: [] });
  assert.ok(!JSON.stringify(result).includes('private credential canary'));
});

test('exhausted duplicate discovery states do not reopen and replay tested controls', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const fixture = '<main><button id=one onclick="if(!document.querySelector(\'#shared\'))document.querySelector(\'main\').insertAdjacentHTML(\'beforeend\',\'<button id=shared>Shared</button>\')">One</button><button id=two onclick="document.querySelector(\'#one\').click()">Two</button></main>';
  let pages = 0;
  const result = await sweepScreen({
    screen: { name: 'Synthetic', path: '/', surface: 'app' }, target: 'desktop', waitMs: 20,
    freshPage: async () => { pages++; const page = await browser.newPage(); await page.setContent(fixture); return page; },
  });
  assert.equal(result.failure, null);
  assert.equal(result.controls.length, 5);
  assert.equal(result.controls.filter(row => row.selector === '#shared').length, 1);
  assert.equal(new Set(result.controls.map(row => row.key)).size, 5);
  assert.equal(pages, 7, 'only the initial and first revealed inventory need base pages');
});

test('session preflight retries bounded transient failures and never retries authentication refusals', async () => {
  for (const mode of ['transport', 'unavailable']) {
    let calls = 0;
    const response = await preflightRequest('session-exchange', async () => {
      calls++;
      if (calls < 3 && mode === 'transport') throw new Error('private provider credential canary');
      return { status: () => calls < 3 ? 503 : 200 };
    }, { pause: async () => {} });
    assert.equal(calls, 3); assert.equal(response.status(), 200);
  }
  let denied = 0;
  assert.equal((await preflightRequest('session-exchange', async () => { denied++; return { status: () => 401 }; }, { pause: async () => {} })).status(), 401);
  assert.equal(denied, 1);
  await assert.rejects(preflightRequest('carr-release', async () => { throw new Error('private provider credential canary'); }, { pause: async () => {} }),
    error => error instanceof SessionPreflightFailure && error.code === 'carr-release-transport-failed' && !error.message.includes('canary'));
});

const frontierFixture = '<main><button id=open aria-expanded=false onclick="const x=document.querySelector(\'#panel\');x.hidden=!x.hidden;this.setAttribute(\'aria-expanded\',String(!x.hidden))">Open drawer</button><section id=panel hidden><button id=child>Nested action</button></section></main>';

test('interruption before post-click discovery resumes the opener frontier without dropping its child', async t => {
  const evidence = await captureControlEvidence(t);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const freshPage = async () => { const page = await browser.newPage(); await page.setContent(frontierFixture); return page; };
  const screen = { name: 'Synthetic', path: '/', surface: 'app' };
  let partial;
  await sweepScreen({ freshPage, screen, target: 'desktop', waitMs: 20, evidence, checkpoint: async row => {
    if (!partial) { partial = structuredClone(row); throw new Error('Synthetic process interruption after durable control record'); }
  } });
  assert.equal(partial.controls.length, 1);
  assert.equal(partial.traversal.pending_discovery.control.selector, '#open');
  validateTraversal(partial);
  const output = await mkdtemp(join(tmpdir(), 'staging-frontier-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
  const plan = { targets: [{ name: 'desktop', surface: 'app' }], routedScreens: [screen] };
  const initial = createSweepRun(plan); initial.record(partial);
  const setup = { release, complete: true, findings: [], needs_restore: [] };
  await persistSweepReport(output, initial, setup);
  const checkpoint = JSON.parse(await readFile(join(output, 'controls.json'), 'utf8'));
  const resumed = createSweepRun({ ...plan, prior: checkpoint }); resumed.assertRelease(release);
  const continued = await sweepScreen({ freshPage, screen, target: 'desktop', waitMs: 20, evidence, prior: resumed.priorScreen('desktop', '/'),
    checkpoint: async row => { validateTraversal(row); resumed.record(row); await persistSweepReport(output, resumed, setup); },
  });
  assert.equal(continued.failure, null);
  assert.equal(continued.controls.length, 3);
  assert.equal(continued.controls.filter(row => row.selector === '#child').length, 1);
  assert.equal(continued.controls.filter(row => row.identity === partial.controls[0].identity).length, 1);
  assert.deepEqual(continued.controls[0], checkpoint.screens[0].controls[0]);
  await assertCapturedPNGs(continued.controls);
  resumed.record(continued); await persistSweepReport(output, resumed, setup);
  assert.equal(resumed.verdict([]).completed, true);
  assert.equal(resumed.snapshot().history.length, 0);
  assert.equal(resumed.snapshot().screens[0].attempt_id, checkpoint.screens[0].attempt_id);
  const original = await sweepScreen({ freshPage, screen, target: 'desktop', waitMs: 20 });
  assert.deepEqual(continued.controls.map(row => [row.key, row.status]).sort(), original.controls.map(row => [row.key, row.status]).sort());
});

test('persisted frontier refuses malformed state and changed opener identity before pressing', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const screen = { name: 'Synthetic', path: '/', surface: 'app' };
  let partial;
  await sweepScreen({ screen, target: 'desktop', waitMs: 20,
    freshPage: async () => { const page = await browser.newPage(); await page.setContent(frontierFixture); return page; },
    checkpoint: async row => { if (!partial) { partial = structuredClone(row); throw new Error('Synthetic interruption'); } },
  });
  for (const mutate of [
    row => row.traversal.seen.push('unmeasured'),
    row => row.traversal.known_remaining++,
    row => row.traversal.max_opener_depth++,
    row => row.traversal.pending_discovery.control.selector = '#unmeasured',
    row => row.traversal.pending_discovery.control.disabled = true,
    row => row.traversal.pending_discovery.control.optionValue = 'different-choice',
    row => row.traversal.pending_discovery.control.identity = 'unmeasured',
    row => row.controls[0].key = 'desktop//0000000000000000',
    row => row.in_progress = false,
  ]) { const bad = structuredClone(partial); mutate(bad); assert.throws(() => validateTraversal(bad), /invalid/); }
  const changed = await sweepScreen({ screen, target: 'desktop', prior: partial, waitMs: 20,
    freshPage: async () => { const page = await browser.newPage(); await page.setContent(frontierFixture.replaceAll('id=open', 'id=changed')); return page; },
  });
  assert.equal(changed.failure.phase, 'frontier-validation');
  assert.equal(changed.failure.code, 'opener-state-changed');
  assert.deepEqual(changed.controls, partial.controls);
});

test('killing frontier publication before canonical commit retains pending discovery and all child coverage', async t => {
  const evidence = await captureControlEvidence(t);
  const root = await mkdtemp(join(tmpdir(), 'staging-frontier-publish-'));
  const output = join(root, 'report'); t.after(() => rm(root, { recursive: true, force: true }));
  const browser = await chromium.launch(); t.after(() => browser.close());
  const freshPage = async () => { const page = await browser.newPage(); await page.setContent(frontierFixture); return page; };
  const screen = { name: 'Synthetic', path: '/', surface: 'app' };
  let partial;
  await sweepScreen({ freshPage, screen, target: 'desktop', waitMs: 20, evidence, checkpoint: async row => {
    if (!partial) { partial = structuredClone(row); throw new Error('Synthetic initial interruption'); }
  } });
  const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
  const plan = { targets: [{ name: 'desktop', surface: 'app' }], routedScreens: [screen] };
  const setup = { release, complete: true, findings: [], needs_restore: [] };
  const initial = createSweepRun(plan); initial.record(partial); await persistSweepReport(output, initial, setup);
  const original = await readFile(join(output, 'controls.json'), 'utf8');
  const source = [
    'import { chromium } from "playwright";',
    'import { readFile, rename } from "node:fs/promises";',
    'import { sweepScreen } from ' + JSON.stringify(new URL('../../scripts/e2e-staging/controls.mjs', import.meta.url).href) + ';',
    'import { createSweepRun } from ' + JSON.stringify(new URL('../../scripts/e2e-staging/resume.mjs', import.meta.url).href) + ';',
    'import { persistSweepReport } from ' + JSON.stringify(new URL('../../scripts/e2e-staging/sweep.mjs', import.meta.url).href) + ';',
    'const output=' + JSON.stringify(output) + ', setup=' + JSON.stringify(setup) + ', plan=' + JSON.stringify(plan) + ', html=' + JSON.stringify(frontierFixture) + ';',
    'const prior=JSON.parse(await readFile(output+"/controls.json","utf8")); const run=createSweepRun({...plan,prior});',
    'const browser=await chromium.launch(); process.on("SIGTERM",async()=>{await browser.close();process.exit(1);});',
    'await sweepScreen({screen:plan.routedScreens[0],target:"desktop",prior:prior.screens[0],waitMs:20,',
    'freshPage:async()=>{const page=await browser.newPage();await page.context().route("**/*",route=>route.abort());await page.setContent(html);return page;},',
    'checkpoint:async row=>{run.record(row);await persistSweepReport(output,run,setup,{publishFile:async(src,dest)=>{',
    'if(dest.endsWith("/controls.json")){await browser.close();process.send({beforeCommit:true});setInterval(()=>{},1000);await new Promise(()=>{});}',
    'await rename(src,dest);}});}});',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', value => { stderr += value; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Publication fixture deadline: ' + stderr)); }, 20_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Publication fixture ended: ' + code + ' ' + stderr)); });
    child.once('message', value => { clearTimeout(timer); assert.equal(value.beforeCommit, true); resolve(); });
  });
  const ended = once(child, 'exit'); child.kill('SIGKILL'); assert.deepEqual(await ended, [null, 'SIGKILL']);
  assert.equal(await readFile(join(output, 'controls.json'), 'utf8'), original);
  const staged = (await readdir(root)).find(name => name.startsWith('.report-report-'));
  const unpublished = JSON.parse(await readFile(join(root, staged, 'controls.json'), 'utf8'));
  assert.equal(unpublished.screens[0].traversal.pending_discovery, null);
  assert.equal(unpublished.screens[0].traversal.known_remaining, 2);
  const checkpoint = JSON.parse(original), run = createSweepRun({ ...plan, prior: checkpoint }); run.assertRelease(release);
  const result = await sweepScreen({ freshPage, screen, target: 'desktop', prior: run.priorScreen('desktop', '/'), waitMs: 20, evidence,
    checkpoint: async row => { run.record(row); await persistSweepReport(output, run, setup); },
  });
  assert.equal(result.failure, null);
  assert.equal(result.controls.length, 3);
  assert.equal(result.controls.filter(row => row.selector === '#child').length, 1);
  await assertCapturedPNGs(result.controls);
  run.record(result); await persistSweepReport(output, run, setup);
  assert.equal(run.verdict([]).completed, true);
  assert.equal(run.snapshot().history.length, 0);
});

test('session-preflight failure retains the unpressed frontier and resumes without retesting completed controls', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const screen = { name: 'Synthetic', path: '/', surface: 'app' };
  const html = '<main><button id=first onclick="document.querySelector(\'output\').textContent=\'First\'">First</button><button id=second onclick="document.querySelector(\'output\').textContent=\'Second\'">Second</button><button id=third onclick="document.querySelector(\'output\').textContent=\'Third\'">Third</button><output></output></main>';
  let pages = 0;
  const freshPage = async () => { const page = await browser.newPage(); await page.setContent(html); return page; };
  const failed = await sweepScreen({ screen, target: 'desktop', waitMs: 20,
    freshPage: async () => { if (++pages === 3) throw new SweepFailure('session-preflight', 'session-exchange-transport-failed'); return freshPage(); },
  });
  assert.equal(failed.failure.phase, 'session-preflight');
  assert.equal(failed.controls.length, 1);
  assert.equal(failed.traversal.known_remaining, 2);
  validateTraversal(failed);
  const resumed = await sweepScreen({ screen, target: 'desktop', waitMs: 20, prior: failed, freshPage });
  assert.equal(resumed.failure, null);
  assert.equal(resumed.controls.length, 3);
  assert.deepEqual(resumed.controls[0], failed.controls[0]);
  assert.equal(resumed.controls.filter(row => row.selector === '#first').length, 1);
  assert.equal(resumed.prior_failures.length, 1);
  assert.equal(resumed.prior_failures[0].retained_controls, 1);
  const findings = (await import('../../scripts/e2e-staging/report.mjs')).sweepFindings([resumed]);
  assert.equal(findings.find(row => row.id.includes('session-exchange-transport-failed')).resolved, true);
});

test('scrubbed share URLs and nested selectors resume through real live actions without identity collisions', async t => {
  const evidence = await captureControlEvidence(t);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const tokens = ['A','B','C','D','E'].map(letter => letter.repeat(43));
  const [first, second, nested, optionA, optionB] = tokens;
  const fixture = '<main><a id=shareA href="/share?token=' + first + '" onclick="event.preventDefault();document.querySelector(\'#outer\').hidden=false">Share one</a><a id=shareB href="/share?token=' + second + '" onclick="event.preventDefault();document.querySelector(\'#outer\').hidden=false">Share two</a><section id=outer role=region hidden><button id="' + nested + '" onclick="document.querySelector(\'#inner\').hidden=false">Open nested</button><section id=inner role=region hidden><select id=choice onchange="document.querySelector(\'#result\').textContent=this.value"><option value="" disabled selected>Choose</option><option value="' + optionA + '">First</option><option value="' + optionB + '">Second</option></select><button id=leaf onclick="document.querySelector(\'#result\').textContent=\'done\'">Finish</button></section></section><output id=result></output></main>';
  const freshPage = async (html = fixture) => { const page = await browser.newPage(); await page.setContent(html); return page; };
  const screen = { name: 'Synthetic', path: '/', surface: 'app' };
  const plan = { targets: [{ name: 'desktop', surface: 'app' }], routedScreens: [screen] };
  let partial;
  await sweepScreen({ freshPage: () => freshPage(), screen, target: 'desktop', waitMs: 20, evidence, checkpoint: async row => {
    if (!partial && row.traversal.pending_discovery?.control.selector === '#' + nested) {
      partial = structuredClone(row); throw new Error('Synthetic interruption before nested discovery');
    }
  } });
  assert.ok(partial);
  assert.ok(partial.controls.some(row => row.selector === '#shareA'));
  assert.ok(partial.controls.some(row => row.selector === '#shareB'));
  const output = await mkdtemp(join(tmpdir(), 'staging-sensitive-frontier-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
  const initial = createSweepRun(plan); initial.record(partial);
  await writeReport(output, { ...initial.snapshot(), release });
  const bytes = await readFile(join(output, 'controls.json'), 'utf8');
  for (const token of tokens) assert.ok(!bytes.includes(token), 'Credential canary remained in canonical checkpoint');
  assert.ok(bytes.includes('[redacted]'));
  const saved = JSON.parse(bytes);
  assert.equal(saved.screens[0].traversal.pending_discovery.control.selector, '#[redacted]');
  const shareRows = saved.screens[0].controls.filter(row => ['#shareA','#shareB'].includes(row.selector));
  assert.equal(shareRows[0].href, shareRows[1].href);
  assert.notEqual(shareRows[0].identity, shareRows[1].identity);
  assert.notEqual(shareRows[0].key, shareRows[1].key);
  const resumed = createSweepRun({ ...plan, prior: saved });
  const selected = new Set();
  const continued = await sweepScreen({ freshPage: () => freshPage(), screen, target: 'desktop', waitMs: 20, prior: resumed.priorScreen('desktop','/'),
    evidence: async (page,row) => { if (row.selector === '#choice') selected.add(await page.locator('#choice').inputValue()); return evidence(page); },
    checkpoint: async row => {
      resumed.record(row); await writeReport(output, { ...resumed.snapshot(), release });
      const persisted = JSON.parse(await readFile(join(output,'controls.json'),'utf8'));
      assert.doesNotThrow(() => createSweepRun({ ...plan, prior: persisted }));
    },
  });
  assert.equal(continued.failure, null);
  assert.deepEqual(continued.controls.slice(0, saved.screens[0].controls.length), saved.screens[0].controls);
  assert.ok(selected.has(optionA) && selected.has(optionB), 'Resume used redacted option metadata instead of the uniquely matched live values');
  assert.ok(continued.controls.some(row => row.selector === '#leaf' && row.status === 'OBSERVED'));
  await assertCapturedPNGs(continued.controls);
  resumed.record(continued); await writeReport(output, { ...resumed.snapshot(), release });
  assert.equal(resumed.verdict([]).completed, true);
  const finalBytes = await readFile(join(output,'controls.json'),'utf8');
  for (const token of tokens) assert.ok(!finalBytes.includes(token));
  const changed = await sweepScreen({ freshPage: () => freshPage(fixture.replaceAll(first, 'Z'.repeat(43))), screen, target: 'desktop', waitMs: 20, prior: saved.screens[0] });
  assert.equal(changed.failure.code, 'opener-state-changed');
  assert.deepEqual(changed.controls, saved.screens[0].controls);
});

test('inventory reobserves navigation context loss within its deadline and keeps fatal reads fatal', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const wrap = (page, read) => new Proxy(page, { get(target, key) {
    if (key === 'locator') return selector => selector === CONTROL_SELECTOR
      ? { evaluateAll: (...args) => read(() => target.locator(selector).evaluateAll(...args)) }
      : target.locator(selector);
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await t.test('replacement document replaces every pre-navigation observation', async () => {
    const page = await browser.newPage(); await page.setContent('<main><button>Old</button></main>');
    let reads = 0;
    const changing = wrap(page, async read => {
      if (++reads === 2) {
        await page.setContent('<main><button>New</button></main>');
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      }
      return read();
    });
    const controls = await settledInventory(changing, { stableMs: 150, timeoutMs: 1500 });
    assert.deepEqual(controls.map(row => row.name), ['New']);
  });
  await t.test('repeated context loss cannot extend the original deadline', async () => {
    const page = await browser.newPage(); await page.setContent('<main><button>Old</button></main>');
    const missing = wrap(page, () => { throw new Error('Execution context was destroyed'); });
    await assert.rejects(settledInventory(missing, { stableMs: 0, timeoutMs: 150 }), /unverified/);
  });
  await t.test('unrelated errors and closed pages are not retried into success', async () => {
    const page = await browser.newPage();
    const fatal = new Error('Synthetic fatal inventory read');
    await assert.rejects(settledInventory(wrap(page, () => { throw fatal; })), error => error === fatal);
    await page.context().close();
    const closed = new Error('Execution context was destroyed');
    await assert.rejects(settledInventory(wrap(page, () => { throw closed; })), error => error === closed);
  });
});

test('recorded action ledger binds evidence and read semantics while all three proposed identities avoid repeated Save', async t => {
  const { planRecordedActionReconciliations, observeRecordedActionReadProof, admitRecordedAction } =
    await import('../../scripts/e2e-staging/recorded-action-reconciliation.mjs');
  const { canonicalIdentity, identityKey, traversalSnapshot } =
    await import('../../scripts/e2e-staging/traversal.mjs');
  const { createHash, randomUUID } = await import('node:crypto');
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const capture = await captureControlEvidence(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  let saveAttempts = 0, saveMutations = 0;
  const { STAGING_ORIGIN } = await import('../../scripts/e2e-staging/session.mjs');
  const record = 'synthetic-record';
  const receipt = { ok: true, deal_id: record, next_step_id: 'synthetic-step',
    next_action_id: null, supersedes: [], created_at: '2026-10-08T00:00:00.000Z' };
  let room = { id: record, deal_id: record, next_step: '', next_date: null,
    thread: [], next_actions: [] };
  const fixture = () => '<main><section role="dialog"><button id="morningClose" type="button" onclick="this.closest(\'section\').hidden=true">Dismiss</button></section><section id="homeCalendar"><div><a hidden>1</a><a hidden>2</a><a hidden>3</a><a href="/deals?deal=synthetic-record" onclick="event.preventDefault();history.pushState({},\'\',this.getAttribute(\'href\'));document.querySelector(\'#recordPanel\').hidden=false;loadRoom()">Open record</a></div></section></main><section id="recordPanel" role="dialog" aria-label="Synthetic record" hidden><form id="detailNextForm" onsubmit="event.preventDefault();saveStep()"><textarea name="text">Follow up</textarea><input name="date" type="date"><button type="submit">Save next step</button></form><button id="outlook" type="button">Deal outlook</button><div id="timeline">' + (saveMutations ? '<button id="timelineDay" type="button" data-timeline-day="2026-10-07" data-detail-focus="day:2026-10-07">Oct7</button>' : '') + '</div></section><script>async function rpc(name,args){const r=await fetch("/mcp",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});return JSON.parse((await r.json()).result.content[0].text)}async function loadRoom(){const room=await rpc("get-deal-room",{deal:"synthetic-record"});document.querySelector("textarea").value=room.next_step||"Follow up";document.querySelector("input").value=room.next_date||""}async function saveStep(){await fixtureSaveAttempt();await rpc("set-next-step",{deal:"synthetic-record",text:document.querySelector("textarea").value.trim(),next_date:document.querySelector("input").value||null,idempotency_key:"synthetic-original-key"});if(!document.querySelector("#timelineDay"))document.querySelector("#timeline").innerHTML=\'<button id="timelineDay" type="button" data-timeline-day="2026-10-07" data-detail-focus="day:2026-10-07">Oct7</button>\';await loadRoom()}</script>';
  const freshPage = async (navigate = true) => {
    const page = await browser.newPage();
    await page.exposeFunction('fixtureSaveAttempt', () => { saveAttempts++; });
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).pathname === '/mcp') {
        const body = route.request().postDataJSON();
        let result = room;
        if (body.params.name === 'set-next-step') {
          saveMutations++;
          room = { ...room, next_step: body.params.arguments.text,
            next_date: body.params.arguments.next_date,
            thread: [{ id: receipt.next_step_id, kind: 'next_step',
              text: body.params.arguments.text, created_at: receipt.created_at }] };
          result = receipt;
        }
        return route.fulfill({ contentType: 'application/json',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1,
            result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }) });
      }
      return route.fulfill({ contentType: 'text/html', body: fixture() });
    });
    if (navigate) await page.goto(STAGING_ORIGIN + '/');
    return page;
  };
  const rawInventory = async page => {
    let raw;
    const proxy = new Proxy(page, { get(target, key) {
      if (key === 'locator') return (...args) => {
        const locator = target.locator(...args);
        return new Proxy(locator, { get(inner, name) {
          if (name === 'evaluateAll') return async (...xs) => {
            const result = await inner.evaluateAll(...xs);
            if (result?.rows) raw = result.rows;
            return result;
          };
          const value = Reflect.get(inner, name);
          return typeof value === 'function' ? value.bind(inner) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const controls = await inventory(proxy);
    return { controls, raw };
  };
  const screen = { path: '/', name: 'Synthetic', surface: 'app', target: 'staging-live',
    reached: true, in_progress: true, attempt_id: randomUUID(), controls: [] };
  const page = await freshPage();
  const opening = [];
  for (const selector of ['#morningClose', '#homeCalendar > div:nth-of-type(1) > a:nth-of-type(4)']) {
    const control = (await inventory(page)).find(row => row.selector === selector);
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: false });
    const result = await pressControl(page, control, { waitMs: 20 });
    await page.waitForLoadState('networkidle');
    const path = await capture(page);
    await page.context().tracing.stop({ path: path.replace(/\.png$/, '.zip') });
    const row = { ...control, ...result, key: screen.target + '/' + screen.path + '/' + identityKey(control.identity),
      target: screen.target, path: screen.path, screen: screen.name, openers: [],
      evidence_path: path };
    screen.controls.push(row); opening.push(row);
  }
  const before = await rawInventory(page);
  const original = before.raw.find(row => row.name === 'Save next step');
  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: false });
  const result = await pressControl(page, original, { waitMs: 20 });
  await page.waitForLoadState('networkidle');
  const path = await capture(page);
  await page.context().tracing.stop({ path: path.replace(/\.png$/, '.zip') });
  const saved = { ...original, ...result, key: screen.target + '/' + screen.path + '/' + identityKey(original.identity),
    target: screen.target, path: screen.path, screen: screen.name,
    openers: opening.map(row => row.name), evidence_path: path };
  screen.controls.push(saved);
  const queued = (await inventory(page)).find(row => row.name === 'Save next step');
  const unresolved = [1, 2].map(index => ({ ...queued,
    identity: canonicalIdentity('unproved-legacy-record-binding-' + index) }));
  screen.traversal = traversalSnapshot({ queue: [queued, ...unresolved].map(control => ({
    openers: [...opening, saved], controls: [control] })),
    destructive: [], active: null, pending: null, seen: new Set(screen.controls.map(row => row.identity)) });
  await page.context().close();
  validateTraversal(screen);
  assert.equal(saveAttempts, 1); assert.equal(saveMutations, 1);
  const prior = { release: { service: 'doctorcre-app', environment: 'staging',
    source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit },
    screens: [screen], history: [], stateObligations: [] };
  const readPage = await freshPage(false);
  const proof = await observeRecordedActionReadProof({ page: readPage, prior, release: prior.release,
    screen, original: saved, queued, openers: opening });
  await readPage.context().close();
  const priorBytes = JSON.stringify(prior), proofBytes = JSON.stringify(proof);
  const plan = await planRecordedActionReconciliations({ prior, proof });
  assert.equal(plan.aliases.length, 1);
  assert.equal(plan.blocked.length, 2, 'Unproved record/action/value bindings remain blocked');
  assert.equal(plan.can_resume, false, 'Ledger design does not enable a runtime handoff');
  assert.equal(JSON.stringify(prior), priorBytes);
  assert.equal(JSON.stringify(proof), proofBytes);
  assert.equal(plan.aliases[0].original_evidence.png, saved.evidence_path);
  assert.equal(plan.aliases[0].original_idempotency_key_sha256.length, 64);
  assert.equal(plan.aliases[0].removed_write_opener, canonicalIdentity(saved.identity));
  for (const control of [queued, ...unresolved]) {
    const alias = plan.aliases.find(row => row.queued_identity === canonicalIdentity(control.identity));
    const candidate = { queued_identity: canonicalIdentity(control.identity),
      value_sha256: alias?.value_sha256 || '0'.repeat(64),
      effect_sha256: alias?.effect_sha256 || '0'.repeat(64) };
    if (alias) {
      const admission = admitRecordedAction(plan, candidate);
      assert.equal(admission.decision, 'already-measured-equivalent');
      assert.equal(admission.action_executed, false);
      assert.throws(() => admitRecordedAction(plan, { ...candidate, as_opener: true }), /proof refused/);
      assert.throws(() => admitRecordedAction(plan, { ...candidate, value_sha256: '0'.repeat(64) }), /proof refused/);
    } else assert.throws(() => admitRecordedAction(plan, candidate), /proof refused/);
    assert.equal(saveAttempts, 1, 'No queued identity or admission decision attempts Save');
    assert.equal(saveMutations, 1, 'No duplicate Save mutation across any of the three identities');
  }
  const mutatingPage = await freshPage(false);
  await assert.rejects(observeRecordedActionReadProof({ page: mutatingPage, prior,
    release: prior.release, screen, original: saved, queued, openers: [...opening, saved] }), /proof refused/);
  await mutatingPage.context().close();
  assert.equal(saveAttempts, 1, 'Mutating opener replay is rejected before clicking');
  assert.equal(saveMutations, 1);
  for (const mutate of [
    value => { value.observations[0].form_values.text = 'Different proposed value'; },
    value => { value.observations[0].save_binding.form_id = 'other-form'; },
    value => { value.observations[0].save_binding.form_action = '/mutating-action'; },
    value => { value.observations[0].current.aria = '|||true'; },
    value => { value.observations[0].read_response.room.next_step = 'Different persisted value'; },
    value => { value.observations[0].read_response.room.thread[0].id = 'different-effect'; },
    value => { value.observations[0].read_response.room.thread[0].actor = 'different-effect-actor'; },
    value => { value.observations[0].current.identity = canonicalIdentity('different-current'); },
    value => { value.observations[0].raw_current.identity = value.observations[0].raw_current.identity.replace('#timelineDay', '#nonTimelineControl'); },
    value => { value.observations[0].addition.detail_focus = 'not-a-day'; },
    value => { value.observations[0].openers[0].policy = 'unproved-button'; },
    value => { value.observations[0].openers[0].dom.form = 'mutating-form'; },
    value => { value.observations[0].openers[1].dom.href = '/deals?deal=other-record'; },
    value => { value.observations[0].openers[0].raw_before.identity = canonicalIdentity('wrong-opener'); },
    value => { value.observations[0].openers.push(value.observations[0].openers[0]); },
  ]) {
    const changed = structuredClone(proof); mutate(changed);
    const refused = await planRecordedActionReconciliations({ prior, proof: changed });
    assert.equal(refused.aliases.length, 0);
    assert.equal(refused.blocked.length, 3);
    assert.equal(JSON.stringify(prior), priorBytes);
    assert.equal(saveMutations, 1);
  }
  for (const mutate of [
    value => { value.checkpoint_sha256 = '0'.repeat(64); },
    value => { value.screen_sha256 = '0'.repeat(64); },
    value => { value.source_attempt = randomUUID(); },
    value => { value.release.source_commit = 'b'.repeat(40); },
    value => { value.producer_sha256 = '0'.repeat(64); },
    value => { value.origin = 'https://unproved.invalid'; },
    value => { value.root_path = '/other'; },
    value => { value.blocked_non_read_requests = 1; },
  ]) {
    const changed = structuredClone(proof); mutate(changed);
    await assert.rejects(planRecordedActionReconciliations({ prior, proof: changed }), /proof refused/);
  }
  assert.equal(JSON.stringify(proof), proofBytes);
  assert.equal(saveAttempts, 1); assert.equal(saveMutations, 1);
});
