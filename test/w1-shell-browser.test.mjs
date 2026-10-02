import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createFixtureClient } from '../js/fixture-client.js';
import { atlasFixtureResponse } from '../scripts/atlas-fixture.mjs';
const root = new URL('../', import.meta.url);
const contract = JSON.parse(await readFile(new URL('contracts/app-routes.v1.json', root)));
const primary = ['Home','Leads','Tours','Local Deals','Vendors','Control Room'];
const secondary = ['Clients','Ideas','Events','Updates','Doc Chats','Progress','Work Requests','All Work','Incidents','Agent Room','Agent Queue','Design Lab','Status'];

async function open(t, { width = 1440, actor = 'joe', live = false, minimal = false, simulatedClock = false, reducedMotion = 'no-preference' } = {}) {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion }); page.setDefaultTimeout(5000);
  if (simulatedClock) await page.clock.install({ time: new Date('2026-10-01T15:00:00Z') });
  const fixture = await createFixtureClient({ selfActor: actor, seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json', root))).toString('base64')}` });
  const errors = [], calls = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); calls.push({ url: url.pathname, method: request.method(), verb: request.postDataJSON?.()?.params?.name });
    if (url.origin === 'http://127.0.0.1:4682') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ state: 'idle' }) });
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/api/system-work/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ actor: { slug: actor }, csrf_token: 'synthetic-test-token' }) });
    if (url.pathname === '/auth/signout') return route.fulfill({ status: 204 });
    if (url.pathname === '/auth/login') return route.fulfill({ contentType: 'text/html', body: '<h1>Signed out</h1>' });
    if (url.pathname === '/api/v1/atlas-graph') { const answer = atlasFixtureResponse(url,'GET'); return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) }); }
    if (url.pathname === '/api/v1/command-center') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(await fixture.commandCenter()) });
    if (url.pathname.startsWith('/api/') || ['/mcp', '/app-release'].includes(url.pathname)) return route.fulfill({ contentType: 'application/json', body: '{}' });
    if (minimal && !/\.(?:m?js|css|json)$/.test(url.pathname)) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-theme="dark"><head><link rel="stylesheet" href="/css/app-shell.css"></head><body><div id="appShell"></div><h1 id="viewerWorkspace">Workspace</h1><script type="module" src="/js/app-shell.js"></script></body></html>' });
    const file = contract.routes[url.pathname] || url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`http://localhost/?actor=${actor}${live ? '&mode=live' : ''}`);
  await page.waitForFunction(() => ['J','D'].includes(document.querySelector('#selfAvatar')?.textContent));
  return { page, errors, calls };
}
for (const actor of ['joe','dell']) test(`signed-in ${actor} gets workspace, account, persisted controls and sign-out`, async t => {
  const { page, errors, calls } = await open(t, { actor, live: true, minimal: true });
  const name = actor === 'joe' ? 'Joe' : 'Dell';
  assert.equal(await page.locator('#viewerWorkspace').textContent(), `${name}'s Workspace`);
  assert.equal(await page.locator('#selfAvatar').textContent(), name[0]);
  await page.getByLabel('Dark mode', {exact:true}).click(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.getByLabel('Color assist', {exact:true}).click();
  await page.reload(); await page.waitForFunction(() => document.documentElement.dataset.colorAssist === 'on');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.locator('#selfAvatar').click(); assert.equal(await page.locator('#accountMenu').isVisible(), true);
  assert.equal(await page.getByText('Notification preferences', {exact:true}).getAttribute('href'), '/updates#prefForm');
  await page.getByText('Theme', {exact:true}).click(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.locator('#selfAvatar').click(); await page.getByText('Profile', {exact:true}).click();
  assert.ok((await page.locator('.app-shell-profile').boundingBox()).width > 900);
  await page.getByLabel('Close profile').click(); await page.locator('#selfAvatar').click(); await page.keyboard.press('Escape'); assert.equal(await page.locator('#accountMenu').isVisible(), false);
  assert.equal(calls.some(call => call.method === 'POST' && !['deal-room-board','today-triage'].includes(call.verb)), false, 'opening controls has no write effect');
  await page.locator('#selfAvatar').click(); await page.getByText('Sign out', {exact:true}).click(); await page.waitForURL('**/auth/login');
  assert.equal(calls.filter(call => call.url === '/auth/signout' && call.method === 'POST' && !['deal-room-board','today-triage'].includes(call.verb)).length, 1); assert.deepEqual(errors, []);
});

test('desktop and phone navigation, account and Call mode work with reduced motion', async t => {
  await mkdir(new URL('test-artifacts/w1b/regression/', root), { recursive: true });
  for (const width of [1440, 390, 320]) await t.test(String(width), async t => {
    const { page, errors, calls } = await open(t, { width, minimal: true, reducedMotion: 'reduce' });
    assert.deepEqual(await page.locator('.app-shell-navigation > a').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label'))), primary);
    await page.getByLabel('More', {exact:true}).click(); assert.deepEqual(await page.locator('.app-shell-more-list a').allTextContents(), secondary);
    assert.equal(await page.locator('[data-app-nav-item]').count(), 19);
    assert.equal(await page.locator('[data-app-nav-item][href="/calendar"], [data-app-nav-item][href="/tasks"]').count(), 0);
    const controls = await page.locator('.app-shell-controls').evaluate(el => [...el.querySelectorAll('button')].filter(e => e.offsetParent).map(e => ({ width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height, transition: getComputedStyle(e).transitionDuration })));
    assert.ok(controls.every(e => e.width >= 44 && e.height >= 44)); assert.ok(controls.every(e => e.transition === '0s'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press('Escape');
    await page.getByLabel('Call mode', {exact:true}).click(); await page.waitForFunction(() => document.querySelector('#callModeDialog')?.open);
    assert.equal(await page.locator('#callModeConsent').isChecked(), false);
    assert.equal(calls.some(call => call.method === 'POST' && !['deal-room-board','today-triage'].includes(call.verb)), false, 'opening Call mode never starts recording');
    const box = await page.locator('#callModeDialog').boundingBox(); assert.ok(box.width >= Math.min(900, width - 40));
    await page.getByLabel('Close Call Mode', {exact:true}).click(); await page.locator('#selfAvatar').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    assert.deepEqual(errors, []);
  });
});

test('all authenticated pages have global controls and fit desktop and phone', async t => {
  const { page, errors } = await open(t, { reducedMotion: "reduce" });
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:960});
    for (const path of Object.keys(contract.routes).filter(path => path !== '/share')) {
      await page.goto(`http://localhost${path}`);
      await page.waitForFunction(() => document.querySelector('#selfAvatar')?.textContent === 'J', null, { timeout:15000 }).catch(error => { error.message = `${path} ${width}px identity: ${error.message}`; throw error; });
      assert.equal(await page.getByLabel('Dark mode',{exact:true}).count(),1,path); assert.equal(await page.locator('#callModeButton').count(),1,path); assert.equal(await page.locator('#colorAssistButton').count(),1,path);
      assert.equal(await page.locator('[data-pref="density"], [data-pref="motion"]').count(),0,path);
      const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, textOverflow: [...document.querySelectorAll("body *")].flatMap(e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => { const r = document.createRange(); r.selectNodeContents(n); return { text:n.textContent, right:r.getBoundingClientRect().right, id:e.id, class:e.className }; })).filter(n=>n.right>innerWidth+1), offenders: [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => ({ id: e.id, class: e.className, right: e.getBoundingClientRect().right })).slice(0,8) }));
      assert.ok(layout.scroll <= layout.width, `${path} ${width}px overflow: ${JSON.stringify(layout)}`);
      if (path === '/') { assert.equal(await page.locator('[href="/tasks"]').count(),0); await page.screenshot({path:new URL(`test-artifacts/w1b/regression/${width === 1440 ? 'desktop' : 'phone'}.png`,root).pathname,fullPage:true}); await page.locator('#selfAvatar').click(); await page.screenshot({path:new URL(`test-artifacts/w1b/regression/${width === 1440 ? 'desktop' : 'phone'}-account.png`,root).pathname,fullPage:true}); await page.locator('#selfAvatar').click(); }
    }
  }
  assert.deepEqual(errors, []);
});


test('an open Deal detail updates automatically without closing its popup', async t => {
  const { page, errors } = await open(t, { simulatedClock: true });
  await page.goto('http://localhost/deals');
  await page.locator('.deal-link').first().click();
  await page.waitForFunction(() => document.querySelector('#dealDialog')?.open);
  const name = await page.locator('#dealDetail h2').textContent();
  const before = await page.locator('#dealDetail .as-of').textContent();
  await page.clock.fastForward(61_000);
  await page.waitForFunction(before => document.querySelector('#dealDetail .as-of')?.textContent !== before, before);
  assert.equal(await page.locator('#dealDetail h2').textContent(), name);
  assert.equal(await page.locator('#dealDialog').evaluate(e => e.open), true);
  await page.getByLabel('Close details', {exact:true}).click();
  await page.clock.fastForward(61_000);
  assert.equal(await page.locator('#dealDialog').evaluate(e => e.open), false);
  assert.deepEqual(errors, []);
});


test('automatic Atlas refresh preserves the selected component', async t => {
  const { page, errors, calls } = await open(t, { simulatedClock: true });
  await page.goto('http://localhost/control-room?tab=system-map');
  await page.locator('[data-atlas-select]').first().click();
  const selected = await page.evaluate(async () => (await import('/js/atlas.js')).view.selected);
  const reads = calls.filter(call => call.url === '/api/v1/atlas-graph').length;
  await page.clock.fastForward(31_000);
  await page.waitForFunction(async reads => (await import('/js/atlas.js')).view.status === 'ready', reads);
  assert.ok(calls.filter(call => call.url === '/api/v1/atlas-graph').length > reads);
  assert.equal(await page.evaluate(async () => (await import('/js/atlas.js')).view.selected), selected);
  assert.deepEqual(errors, []);
});
