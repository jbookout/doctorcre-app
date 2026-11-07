import test from 'node:test';
import assert from 'node:assert/strict';
import { prove } from '../scripts/prove-mail-priority-panel.mjs';
const expectedCommit = '1'.repeat(40);
function setup({ observed = expectedCommit, failing = false, stall = false, late = false } = {}) {
  let pages = 0, sharedClosed = 0;
  const button = { waitFor: async () => {}, click: async () => {}, first() { return this; }, count: async () => 0 };
  const page = { close: async () => { pages--; }, goto: async () => {}, url: () => 'http://localhost/', getByRole: () => ({ ...button, getByRole: () => button }), waitForResponse: async () => ({ ok: () => true, status: () => 200, json: async () => ({ state: 'empty' }) }), waitForFunction: async () => {}, evaluate: async () => { if (stall) return new Promise(() => {}); assert.ok(!failing, 'Synthetic containing release assertion'); return { count: 0 }; } };
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

import { createServer } from 'node:http';
test('real CDP closes a late-acquired page before disconnecting and preserves existing pages', async t => {
  const root = temporaryDirectory('mail-proof-late-cdp-page-', t);
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const context = await chromium.launchPersistentContext(root, { headless: true, args: [...CHROMIUM_SAFETY_ARGS, `--remote-debugging-port=${port}`] });
  const cdpUrl = `http://127.0.0.1:${port}`;
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
