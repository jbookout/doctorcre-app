import { ownedCdpFixture } from "./owned-cdp-fixture.ts";
export const browserCases = [];
function test(name, run) { browserCases.push([name, run]); }
import assert from 'node:assert/strict';
import { prove } from '../scripts/prove-mail-priority-panel.mjs';
const expectedCommit = '1'.repeat(40);
function setup({ observed = expectedCommit, failing = false, stall = false, late = false } = {}) {
  let pages = 0, sharedClosed = 0;
  const button = { waitFor: async () => {}, click: async () => {}, first() { return this; }, count: async () => 0 };
  const page = { locator: () => button, close: async () => { pages--; }, goto: async () => {}, url: () => 'http://localhost/', getByRole: () => ({ ...button, getByRole: () => button }), waitForResponse: async () => ({ ok: () => true, status: () => 200, json: async () => ({ state: 'empty' }) }), waitForFunction: async () => {}, evaluate: async () => { if (stall) return new Promise(() => {}); assert.ok(!failing, 'Synthetic containing release assertion'); return { count: 0 }; } };
  const context = { async newPage() { if (late) await new Promise(resolve => setTimeout(resolve, 60)); pages++; return page; } };
  return { options: { origin: 'http://localhost', expectedCommit, cdpUrl: 'http://localhost:9222', timeoutMs: 500, releaseReader: async () => ({ source_commit: observed }), engine: { connectOverCDP: async () => ({ contexts: () => [context], close: async () => { sharedClosed++; } }) } }, resources: () => ({ pages, sharedClosed }) };
}
for (const mode of ['equal', 'descendant', 'older', 'unrelated', 'unknown']) test(`release containment ${mode}`, async () => {
  const fixture = setup({ observed: mode === 'equal' ? expectedCommit : '2'.repeat(40) });
  fixture.options.ancestry = async () => mode === 'descendant';
  if (['equal', 'descendant'].includes(mode)) assert.equal((await prove(fixture.options)).status, 'passed');
  else await assert.rejects(prove(fixture.options), { exitCode: 78 });
  assert.deepEqual(fixture.resources(), { pages: 0, sharedClosed: ['equal', 'descendant'].includes(mode) ? 1 : 0 });
});
test('containing release assertion failure exits 1, missing session exits 78', async () => {
  const failure = setup({ failing: true });
  await assert.rejects(prove(failure.options), error => (error.exitCode || 1) === 1);
  const missing = setup(); delete missing.options.cdpUrl;
  await assert.rejects(prove(missing.options), { exitCode: 78 });
});
for (const mode of ['late acquisition', 'stalled evaluation']) test(`timeout cleanup ${mode}`, async () => {
  const fixture = setup({ late: mode === 'late acquisition', stall: mode === 'stalled evaluation' });
  await assert.rejects(prove({ ...fixture.options, timeoutMs: 20 }), { exitCode: 78 });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(fixture.resources(), { pages: 0, sharedClosed: 1 });
});

import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { ownedBrowserProcesses } from './proof-browser-harness.mjs';
for (const mode of ['late launch', 'stalled evaluation']) test(`real owned Chromium cleanup ${mode}`, async t => {
  const root = temporaryDirectory('mail-proof-timeout-', t);
  let context, acquisition, closed, observed = [];
  const fixture = setup({ stall: mode === 'stalled evaluation' });
  fixture.options.engine = { connectOverCDP() {
    acquisition = (async () => {
      context = await chromium.launchPersistentContext(root, { headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
      observed = ownedBrowserProcesses(root);
      const browser = context.browser();
      const close = browser.close.bind(browser);
      let finishClose;
      closed = new Promise(resolve => finishClose = resolve);
      browser.close = async () => { try { await close(); } finally { finishClose(); } };
      if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 2200));
      else {
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          page.goto = async () => {};
          page.url = () => 'http://localhost/';
          const button = { waitFor: async () => {}, click: async () => {}, first() { return this; }, count: async () => 0 };
          page.getByRole = () => ({ ...button, getByRole: () => button });
          page.waitForResponse = async () => ({ ok: () => true, status: () => 200, json: async () => ({ state: 'empty' }) });
          page.waitForFunction = async () => {};
          page.evaluate = () => new Promise(() => {});
          return page;
        };
      }
      return browser;
    })();
    return acquisition;
  } };
  try {
    await assert.rejects(prove({ ...fixture.options, timeoutMs: 2000 }), { exitCode: 78 });
    await acquisition;
    await closed;
    assert.ok(observed.length > 0, 'real owned browser processes observed');
    assert.deepEqual(ownedBrowserProcesses(root), [], 'zero surviving owned browser processes');
    t.diagnostic(JSON.stringify({ mode, exit: 78, observed: observed.length, survivors: 0 }));
  } finally { await context?.close(); }
});

import { startFixture } from '../scripts/fixture-http.mjs';
test('real CDP closes a late-acquired page before disconnecting and preserves existing pages', async t => {
  const root = temporaryDirectory('mail-proof-late-cdp-page-', t);

  const contextFixture = await ownedCdpFixture(); t.after(() => contextFixture.close());
  const context = contextFixture.context;
  const cdpUrl = contextFixture.endpoint;
  const existing = context.pages()[0];
  let acquisition, inspection;
  const fixture = setup();
  fixture.options.engine = { async connectOverCDP(...args) {
    const browser = await chromium.connectOverCDP(...args);
    const sharedContext = browser.contexts()[0];
    const newPage = sharedContext.newPage.bind(sharedContext);
    sharedContext.newPage = () => acquisition = (async () => {
      const page = await newPage();
      await new Promise(resolve => setTimeout(resolve, 700));
      return page;
    })();
    return browser;
  } };
  try {
    await existing.goto('data:text/html,existing-user-page');
    const originalUrls = context.pages().map(page => page.url());
    await assert.rejects(prove({ ...fixture.options, cdpUrl, timeoutMs: 500 }), { exitCode: 78 });
    assert.ok(acquisition, 'page acquisition started before the deadline');
    await acquisition;
    inspection = await chromium.connectOverCDP(cdpUrl);
    assert.deepEqual(inspection.contexts()[0].pages().map(page => page.url()), originalUrls, 'zero surviving owned tabs and all existing pages preserved');
    assert.equal(existing.isClosed(), false, 'borrowed browser remains usable');
    t.diagnostic(JSON.stringify({ exit: 78, survivingOwnedPages: 0, preservedPages: originalUrls.length }));
  } finally {
    await inspection?.close();
    await context.close();
  }
});

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appAssetSnapshot } from '../scripts/fixture-app-assets.mjs';
const exec = promisify(execFile);
const recordings = JSON.parse(await readFile(new URL('./fixtures/mail-priority-panel/recordings.json', import.meta.url)));
const assets = await appAssetSnapshot();
const json = value => ({ body: JSON.stringify(value), contentType: 'application/json' });
async function cli(origin, cdpUrl, preload) {
  try {
    const result = await exec(process.execPath, [...(preload ? ['--import', preload] : []), 'scripts/prove-mail-priority-panel.mjs', '--origin', origin, '--expected-commit', expectedCommit, '--cdp-url', cdpUrl, '--timeout-ms', '10000']);
    return { code: 0, receipt: JSON.parse(result.stdout) };
  } catch (error) { return { code: error.code, receipt: JSON.parse(error.stdout) }; }
}
for (const mode of ['unreachable', 'connection rejection', 'page rejection']) test(`CLI acquisition ${mode} is insufficient evidence`, async t => {
  const server = await startFixture({ routes: new Map([['/app-release', json({ service: 'doctorcre-app', environment: 'production', source_commit: expectedCommit })]]) });
  t.after(() => server.close());
  let preload;
  if (mode !== 'unreachable') {
    preload = temporaryDirectory('mail-acquisition-', t) + '/preload.mjs';
    await writeFile(preload, `import { chromium } from ${JSON.stringify(new URL('../node_modules/playwright/index.mjs', import.meta.url).href)};
chromium.connectOverCDP = async () => { ${mode === 'connection rejection' ? "throw Error('Connection closed');" : "return { contexts: () => [{ newPage: async () => { throw Error('Page closed'); } }], close: async () => {} };"} };`);
  }
  const result = await cli(server.origin, 'http://127.0.0.1:1', preload);
  assert.equal(result.code, 78, JSON.stringify(result));
});

test('actual CLI compares every displayed evidence field exactly', async t => {

  const root = temporaryDirectory('mail-exact-cdp-', t);
  const contextFixture = await ownedCdpFixture(); t.after(() => contextFixture.close());
  const context = contextFixture.context;
  t.after(() => context.close());
  const mutations = {
    correct: '',
    date: `row.querySelector('time').textContent = '9' + row.querySelector('time').textContent`,
    reason: `row.querySelector('p').firstChild.textContent = 'Wrong ' + row.querySelector('p').firstChild.textContent`,
    mailbox: `host.querySelector('p').textContent = host.querySelector('p').textContent.replace('Mailbox joe', 'Mailbox xjoe')`,
    coverage: `host.querySelector('p').textContent += ' wrong'`,
    'leading 11 for 1': `row.querySelector('time').textContent = row.querySelector('time').textContent.replace('-10-01', '-10-011')`,
    'leading 16 for 6': `row.querySelector('time').textContent = row.querySelector('time').textContent.replace('2026', '20216')`,
    'source time': `row.querySelectorAll('p')[1].textContent += ' wrong'`,
    pagination: `host.querySelector('ol').previousElementSibling.textContent += ' wrong'`,
    id: `row.dataset.mailProposal = 'wrong'`,
  };
  for (const [mode, mutation] of Object.entries(mutations)) await t.test(mode, async () => {
    const html = assets.get('/workspace.html').body.toString().replace('<head>', `<head><script>history.replaceState(null,'','/?mode=fixture');new MutationObserver((_, observer) => {const host=document.querySelector('section[aria-label="Mail priorities"]');const row=host?.querySelector('[data-mail-proposal]');if(row){observer.disconnect();${mutation};}}).observe(document,{subtree:true,childList:true});</script>`);
    const server = await startFixture({ assets, routes: new Map([
      ['/', { body: html, contentType: 'text/html' }],
      ['/app-release', json({ service: 'doctorcre-app', environment: 'production', source_commit: expectedCommit })],
      ['/auth/session', json({ actor: { slug: 'joe' }, csrf_token: 'synthetic' })],
      ['/api/v1/intelligence/mail-needs-partner', json(recordings.ready)],
    ]) });
    try {
      const result = await cli(server.origin, contextFixture.endpoint);
      assert.equal(result.code, mode === 'correct' ? 0 : 1, `${mode} ${JSON.stringify(result)}`);
      assert.equal(context.pages().length, 1, 'only the preexisting page survives');
    } finally { await server.close(); }
  });
});

test('release reader failure retains its status and cause', async () => {
  const cause = Error('upstream refused');
  const failure = Object.assign(new Error('Proof HTTP unavailable (503)', { cause }), { exitCode: 78, status: 503 });
  await assert.rejects(prove({ ...setup().options, releaseReader: async () => { throw failure; } }), error => error === failure && error.status === 503 && error.cause === cause);
});
test('CLI release reader reports its actual refusal', async t => {
  const server = await startFixture({ routes: new Map([['/app-release', { status: 503, body: 'Unavailable' }]]) });
  t.after(() => server.close());
  const result = await cli(server.origin, 'http://127.0.0.1:1');
  assert.equal(result.code, 78);
  assert.equal(result.receipt.error, 'Proof HTTP unavailable (503)');
});
