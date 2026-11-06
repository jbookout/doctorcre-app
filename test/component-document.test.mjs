import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, fixtureServer, componentDocument } from './browser-harness.mjs';

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
  } finally { await browser.close(); }
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
