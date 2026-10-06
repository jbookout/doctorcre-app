import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../../test/browser-harness.mjs';
import { CONTROL_SELECTOR, inventory, pressControl, sweepScreen, settledInventory } from '../../scripts/e2e-staging/controls.mjs';
import { assertStagingURL, readSessionSecret } from '../../scripts/e2e-staging/session.mjs';
import { newDeadControls, explorationEvidence } from '../../scripts/e2e-staging/report.mjs';
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
