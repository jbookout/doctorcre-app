import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { launchProofBrowser, proofFetch, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { createFixtureClient } from '../js/fixture-client.js';

async function observe(fixtures) {
  const { mountAppLayout } = await import('/js/app-layout.js');
  const { mountMeetingPreparation } = await import('/js/meeting-preparation.js');
  const { createLiveClient } = await import('/js/live-client.js');
  mountAppLayout(document, document.querySelector('header'), '/');
  const retry = () => document.getElementById('appTodayRetry').onclick();
  await retry();
  const panels = () => ['appCalendarSlot', 'appScheduleSlot'].map(id => document.getElementById(id).textContent);
  if (!panels().every(text => text.includes(fixtures['calendar-meeting-prep'].items[0].title))) throw Error('Initial preparation did not render in both panels');
  await window.proofHold();
  const pending = retry();
  const client = createLiveClient();
  const preparation = mountMeetingPreparation({ document, window, client });
  const opening = preparation.open(document.querySelector('#open'), 'America/Chicago');
  await window.proofHeld();
  const dialog = document.querySelector('.meeting-preparation');
  if (!dialog.open || !dialog.textContent.includes('Loading meeting preparation')) throw Error('Loading dialog was not observed');
  dialog.querySelector('[data-prep-close]').click();
  await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
  const closed = panels();
  const marker = 'Demo retired private preparation';
  const fresh = 'Demo current preparation';
  await window.proofRelease();
  await Promise.all([pending, opening]);
  const after = panels();
  if (dialog.open || document.body.textContent.includes(marker) || JSON.stringify(after) !== JSON.stringify(closed)) throw Error('Retired preparation repainted after close');
  await window.proofFresh();
  await preparation.open(document.querySelector('#open'), 'America/Chicago');
  await retry();
  if (!dialog.open || !dialog.textContent.includes(fresh) || !panels().every(text => text.includes(fresh))) throw Error('Fresh preparation failed after close');
  preparation.dispose();
  window.dispatchEvent(new Event('pagehide'));
  return { initial_render: true, held_reads: 2, closed_without_repaint: true, fresh_read_recovery: true };
}

export async function prove({ fixtureRoot, origin = 'https://app.doctorcre.com', timeoutMs = 30000, engine = chromium }) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'bounded deadline');
  const base = new URL(origin);
  assert.ok(['https:', 'http:'].includes(base.protocol) && base.origin === origin && !base.username && !base.password, 'origin only');
  const unavailable = message => Object.assign(new Error(message), { exitCode: 78 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(unavailable('Proof deadline exceeded')), timeoutMs);
  let browser, bytes = 0, requests = 0, routeFailure;
  const assets = new Map();
  let root, release;
  async function read(path) {
    controller.signal.throwIfAborted();
    assert.ok(++requests <= 96, 'request cap');
    let body;
    if (root) {
      const file = await realpath(resolve(root, `.${path}`));
      assert.ok(file.startsWith(root + sep), 'fixture path confined');
      body = await readFile(file);
    } else {
      const response = await proofFetch(new URL(path, origin), { signal: controller.signal });
      if (!response.ok || !/javascript/.test(response.headers.get('content-type'))) throw unavailable('Deployed JavaScript unavailable');
      const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        assert.ok(bytes <= 16 * 1024 * 1024, 'byte cap');
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    if (root) { bytes += body.length; assert.ok(bytes <= 16 * 1024 * 1024, 'byte cap'); }
    assets.set(path, body);
    return body;
  }
  try {
    root = fixtureRoot ? await realpath(fixtureRoot) : null;
    release = root ? null : await readAppRelease(origin, url => proofFetch(url, { signal: controller.signal }).then(async response => ({ type: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) })));
    const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}` });
    const fixtures = { 'read-home-agenda': await fixture.getHomeAgenda(), 'deal-room-board': await fixture.getBoard(), 'morning-brief': await fixture.morningBrief(), 'calendar-meeting-prep': await fixture.calendarMeetingPrep(), 'today-triage': await fixture.todayTriage(), 'list-feature-switches': await fixture.listFeatureSwitches() };
    assert.ok(fixtures['calendar-meeting-prep'].items.length > 0, 'nonempty contract fixture');
    await read('/js/app-layout.js');
    browser = await launchProofBrowser(engine, { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs }, { signal: controller.signal });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Chicago', serviceWorkers: 'block' });
    await page.clock.install({ time: new Date(fixtures['calendar-meeting-prep'].items[0].start) });
    let held = false, heldReads = 0, fixtureReads = 0, releaseRead, bothHeld;
    const gate = new Promise(resolve => { releaseRead = resolve; });
    const reached = new Promise(resolve => { bothHeld = resolve; });
    await page.exposeFunction('proofHold', () => { held = true; });
    await page.exposeFunction('proofHeld', () => reached);
    await page.exposeFunction('proofRelease', () => { releaseRead(); });
    await page.exposeFunction('proofFresh', () => { held = false; fixtures['calendar-meeting-prep'].notes = ['Demo current preparation']; });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/mcp' && route.request().method() === 'POST') {
        if (++fixtureReads > 32) { routeFailure = Error('Fixture read budget exceeded'); return route.abort(); }
        const rpc = route.request().postDataJSON();
        let value = fixtures[rpc.params.name];
        if (!value) { routeFailure = Error(`Unexpected fixture read ${rpc.params.name}`); return route.abort(); }
        if (rpc.params.name === 'calendar-meeting-prep' && held) {
          if (++heldReads === 2) bothHeld();
          await gate;
          value = { ...value, notes: ['Demo retired private preparation'] };
        }
        return route.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } }).catch(() => {});
      }
      if (route.request().method() !== 'GET') return route.abort();
      if (url.pathname === '/auth/session') return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-proof-only' } });
      if (url.pathname === '/__preparation-proof') return route.fulfill({ contentType: 'text/html', body: '<header></header><main><h1>Home</h1><button id="open">Prepare meetings</button><div data-layout-slot="moves"></div></main>' });
      if (!/^\/js\/[a-zA-Z0-9._/-]+\.m?js$/.test(url.pathname)) return route.abort();
      try { await route.fulfill({ contentType: 'text/javascript', body: assets.get(url.pathname) || await read(url.pathname) }); }
      catch (error) { routeFailure = error; await route.abort(); }
    });
    await page.goto(`${origin}/__preparation-proof?mode=live`);
    const observation = await page.evaluate(observe, fixtures).catch(error => { throw routeFailure || error; });
    if (!root) {
      const after = await readAppRelease(origin, url => proofFetch(url, { signal: controller.signal }).then(async response => ({ type: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) })));
      assert.deepEqual(after, release, 'unchanged release');
    }
    return { ok: true, evidence: root ? 'local_fixture' : 'deployed_home_modules_with_contract_fixture', natural_authenticated_observation: 'not_run', release, observation, requests, loaded_assets: [...assets].map(([path, body]) => ({ path, sha256: createHash('sha256').update(body).digest('hex') })) };
  } catch (error) {
    error.receipt = { release, evidence: root ? 'local_fixture' : 'deployed_home_modules_with_contract_fixture', requests, loaded_assets: [...assets].map(([path, body]) => ({ path, sha256: createHash('sha256').update(body).digest('hex') })) };
    throw error;
  } finally { clearTimeout(timer); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 4 && ['--fixture-root', '--origin'].includes(args[0]) && args[2] === '--timeout-ms', 'usage: --origin URL | --fixture-root PATH, followed by --timeout-ms 30000');
    console.log(JSON.stringify(await prove({ [args[0] === '--origin' ? 'origin' : 'fixtureRoot']: args[1], timeoutMs: Number(args[3]) })));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message, ...error.receipt })); process.exitCode = error.exitCode || 1; }
}
