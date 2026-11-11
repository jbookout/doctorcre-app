import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, componentDocument } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

test('component document discards initialized shell listeners instead of replacing its body', async () => {
  const server = await fixtureServer(), browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.origin);
    await page.evaluate(() => {
      window.oldDocumentCalls = 0;
      window.addEventListener('focus', () => { window.oldDocumentCalls++; });
    });
    await componentDocument(page, server.origin);
    assert.equal(await page.evaluate(() => window.oldDocumentCalls), undefined);
    assert.equal(await page.locator('#appConnection').count(), 0);
    await page.close();
    assert.equal(page.context().browser().contexts().length, 0);
  } finally { await browser.close(); await server.close(); }
});

test('missing unsubscribe fails before context closure and still releases the context', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await componentDocument(page, 'http://localhost', { owner: 'negative-fixture' });
    await page.evaluate(() => window.addEventListener('doctorcre-session-invalidated', () => {}));
    await assert.rejects(page.close(), /negative-fixture.*doctorcre-session-invalidated/);
    assert.equal(page.isClosed(), true);
    assert.equal(page.context().browser().contexts().length, 0);
  } finally { await browser.close(); }
});

test('normal unsubscribe, once and signal listeners return to baseline', async () => {
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 3; i++) {
      const page = await browser.newPage();
      await componentDocument(page, 'http://localhost');
      await page.evaluate(() => {
        const callback = () => {};
        window.addEventListener('focus', callback);
        window.addEventListener('focus', callback);
        window.removeEventListener('focus', callback);
        window.addEventListener('online', callback, { once: true });
        window.dispatchEvent(new Event('online'));
        const controller = new AbortController();
        document.addEventListener('visibilitychange', callback, { signal: controller.signal });
        controller.abort();
      });
      await page.close();
      assert.equal(page.context().browser().contexts().length, 0);
    }
  } finally { await browser.close(); }
});

test('component failure closes context and drains pending owned routes', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await componentDocument(page, 'http://localhost');
    let finish, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { finish = resolve; });
    let drained = false;
    await page.route('**/held', async route => {
      entered(); await held;
      await route.fulfill({ body: 'synthetic' }); drained = true;
    });
    await page.evaluate(() => { void fetch('/held'); });
    await started;
    const closing = page.close();
    finish();
    await closing;
    assert.equal(drained, true);
    assert.equal(page.context().browser().contexts().length, 0);
  } finally { await browser.close(); }
});

test('page errors remain failures while context teardown still runs', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await componentDocument(page, 'http://localhost');
    const errored = page.waitForEvent('pageerror');
    await page.evaluate(() => setTimeout(() => { throw new Error('component exploded'); }));
    await errored;
    await assert.rejects(page.close(), /component exploded/);
    assert.equal(page.isClosed(), true);
  } finally { await browser.close(); }
});


test('navigation refuses a retained listener before discarding the evidence', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await componentDocument(page, 'http://localhost', { owner: 'navigation fixture' });
    await page.evaluate(() => window.addEventListener('online', () => {}));
    await assert.rejects(page.goto('about:blank'), /navigation fixture.*online/);
    assert.equal(new URL(page.url()).pathname, '/__component-document__');
    await assert.rejects(page.close(), /navigation fixture.*online/);
    assert.equal(page.isClosed(), true);
  } finally { await browser.close(); }
});

test('a throwing disposer still closes its context', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await componentDocument(page, 'http://localhost', { dispose() { throw Error('dispose failed'); } });
    await assert.rejects(browser.close(), /dispose failed/);
    assert.equal(page.isClosed(), true);
    assert.equal(page.context().browser().contexts().length, 0);
  } finally { await assert.rejects(browser.close(), /dispose failed/); }
});

test('a test exception retires its view and context through finally', async () => {
  const browser = await chromium.launch();
  let page;
  await assert.rejects(async () => {
    try {
      page = await browser.newPage();
      await componentDocument(page, 'http://localhost', { dispose: page => page.evaluate(() => window.unsubscribe()) });
      await page.evaluate(() => {
        const listener = () => {};
        window.addEventListener('focus', listener);
        window.unsubscribe = () => window.removeEventListener('focus', listener);
      });
      throw Error('assertion failed');
    } finally { await browser.close(); }
  }, /assertion failed/);
  assert.equal(page.isClosed(), true);
  assert.equal(page.context().browser().contexts().length, 0);
});


test('the standalone missing-unsubscribe negative fixture exits with a test failure', async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(
    promisify(execFile)(process.execPath, ['--test', fileURLToPath(new URL('./fixtures/missing-unsubscribe.mjs', import.meta.url))], { timeout: 30_000, env }),
    error => error.code === 1 && /missing-unsubscribe fixture.*doctorcre-session-invalidated/s.test(error.stdout),
  );
});

test('browser close drains every context and held route before rejecting, and repeated close joins completion', async () => {
  const browser = await chromium.launch();
  const first = await browser.newPage(), second = await browser.newPage();
  let releaseDispose, releaseRoute, routeEntered;
  const disposal = new Promise(resolve => { releaseDispose = resolve; });
  const routeHeld = new Promise(resolve => { releaseRoute = resolve; });
  const entered = new Promise(resolve => { routeEntered = resolve; });
  await componentDocument(first, 'http://localhost', { owner: 'first leak' });
  await first.evaluate(() => window.addEventListener('focus', () => {}));
  await componentDocument(second, 'http://localhost', { dispose: () => disposal });
  await second.route('**/held', async route => { routeEntered(); await routeHeld; await route.fulfill({ body: 'released' }); });
  await second.evaluate(() => { window.heldFetch = fetch('/held'); });
  await entered;
  let settled = false;
  const closing = browser.close();
  const outcome = closing.then(() => { settled = true; }, () => { settled = true; });
  try {
    await assert.rejects(first.close(), /first leak/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'first rejection must not finish browser close');
    assert.equal(second.isClosed(), false);
    assert.equal(browser.close(), closing, 'repeated close returns the same completion promise');
    releaseDispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'held route must drain before close settles');
    releaseRoute();
    await assert.rejects(closing, /first leak/);
    assert.equal(second.isClosed(), true);
    assert.equal(second.context().browser().contexts().length, 0);
    assert.equal(browser.close(), closing, 'failure remains the idempotent result');
  } finally {
    releaseDispose(); releaseRoute();
    await outcome;
    await second.context().close().catch(() => {});
  }
});
