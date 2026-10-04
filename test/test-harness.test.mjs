// Keeps browser and JSDOM tests on their shared harnesses: the CI failures
// these replace came from per-test Chromium launches, per-file wait budgets of
// 1-7 s, a wall-clock pauseAt race and threadpool-bound hashing in settle().
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { pbkdf2, webcrypto } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { animationsSettled, chromium, webkit, pausedClock, settles, waitForAsync } from './browser-harness.mjs';
import { openDom } from './jsdom-harness.mjs';

const dir = new URL('./', import.meta.url);
// This file reproduces the patterns it forbids, so it scans every other test.
const sources = await Promise.all((await readdir(dir)).filter(name => /\.test\.mjs$/.test(name) && name !== 'test-harness.test.mjs')
  .map(async name => ({ name, text: await readFile(new URL(name, dir), 'utf8') })));

function assertSharedBrowserBudget(text, name) {
  // Non-browser tests bound child processes too; those are not page waits.
  if (/from ['"].*browser-harness\.mjs['"]/.test(text)) {
    assert.doesNotMatch(text, /[{,]\s*timeout\s*:\s*\d/, `${name} gives one wait its own budget`);
  }
}

test('the browser wait-budget guard permits bounded subprocess tests and rejects a page override', () => {
  assertSharedBrowserBudget("spawnSync(process.execPath, [], {timeout:3000})", 'subprocess');
  assert.throws(() => assertSharedBrowserBudget("import { chromium } from './browser-harness.mjs'; page.waitForFunction(() => true, {timeout:3000})", 'browser'), /gives one wait its own budget/);
});

test('every browser test gets its engine from the harness and waits on its one budget', () => {
  for (const { name, text } of sources) {
    assert.doesNotMatch(text, /from ['"]playwright['"]/, `${name} imports Playwright directly`);
    assert.doesNotMatch(text, /setDefaultTimeout\(/, `${name} sets its own wait budget`);
    assertSharedBrowserBudget(text, name);
    assert.doesNotMatch(text, /waitForFunction\(\s*async/, `${name} waits on an async predicate, which never waits`);
    assert.doesNotMatch(text, /for\s*\(\s*let \w+\s*=\s*0;[^;]*;\s*\w+\+\+\s*\)\s*await page\.waitForTimeout/, `${name} polls with its own fixed budget`);
  }
});

test('an async predicate is awaited to completion, unlike waitForFunction', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<p>loaded</p>');
    await page.evaluate(() => { window.ready = false; });
    await page.waitForFunction(async () => window.ready);
    await delay(600); // A caller may be descheduled between browser reads.
    assert.equal(await page.evaluate(() => window.ready), false, 'waitForFunction returned before its async predicate held');
    let completed = false;
    const waiting = waitForAsync(page, async () => { window.readStarted = true; return window.ready; })
      .then(() => { completed = true; });
    await page.waitForFunction(() => window.readStarted);
    assert.equal(completed, false, 'the wait stays pending while readiness is held');
    await page.evaluate(() => { window.ready = true; });
    await waiting;
    assert.equal(await page.evaluate(() => window.ready), true);
  } finally { await browser.close(); }
});

test('settles reruns an assertion until the state arrives and rethrows when it never does', async () => {
  let value = 0;
  setTimeout(() => { value = 1; }, 100);
  await settles(() => assert.equal(value, 1));
  await assert.rejects(settles(() => assert.equal(value, 2), 200), /strictly equal/);
});

test('every script-running JSDOM page is opened through the harness', () => {
  for (const { name, text } of sources) assert.doesNotMatch(text, /new JSDOM\([^)]*runScripts/, `${name} opens a scripted JSDOM directly`);
});

test('launches share one Chromium while each test keeps its own storage', async () => {
  const [a, b] = await Promise.all([chromium.launch(), chromium.launch()]);
  const [pageA, pageB] = await Promise.all([a.newPage(), b.newPage()]);
  await Promise.all([pageA, pageB].map(page => page.goto('data:text/html,<title>x</title>')));
  assert.equal(pageA.context().browser(), pageB.context().browser());
  assert.notEqual(pageA.context(), pageB.context());
  await a.close();
  assert.equal(pageA.isClosed(), true);
  assert.equal(await pageB.evaluate(() => 1 + 1), 2);
  await b.close();
});

test('WebKit leases share their engine while keeping contexts and Chromium separate', async t => {
  const [a, b, chrome] = await Promise.all([webkit.launch(), webkit.launch(), chromium.launch()]);
  t.after(() => Promise.all([a.close(), b.close(), chrome.close()]));
  const [pageA, pageB, pageChrome] = await Promise.all([a.newPage(), b.newPage(), chrome.newPage()]);
  assert.equal(pageA.context().browser(), pageB.context().browser());
  assert.notEqual(pageA.context().browser(), pageChrome.context().browser());
  assert.notEqual(pageA.context(), pageB.context());
  await a.close();
  assert.equal(pageA.isClosed(), true);
  assert.equal(await pageB.evaluate(() => 1 + 1), 2);
});

test('WebKit pages refuse outside requests and retain test fixture routes', async t => {
  const browser = await webkit.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const refused = [];
  page.on('requestfailed', request => refused.push(new URL(request.url()).hostname));
  await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans"><p>loaded</p>' }));
  await page.goto('http://localhost/');
  assert.deepEqual(refused, ['fonts.googleapis.com']);
  assert.equal(await page.locator('p').innerText(), 'loaded');
});

test('a paused clock lands exactly on its time however long the runner stalls', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const now = new Date('2026-10-01T15:00:00Z');
    await page.goto('data:text/html,<p>loaded</p>');
    await pausedClock(page, now);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await page.evaluate(() => Date.now()), now.valueOf());
    // The pattern it replaces: install at `now`, stall, then pause at `now`.
    const racy = await browser.newPage();
    await racy.goto('data:text/html,<p>loaded</p>');
    await racy.clock.install({ time: now });
    await new Promise(resolve => setTimeout(resolve, 50));
    await racy.evaluate(() => Date.now());
    await assert.rejects(racy.clock.pauseAt(now), /Cannot fast-forward to the past/);
  } finally { await browser.close(); }
});

test('JSDOM hashing finishes within settle turns while the threadpool is saturated', async () => {
  const dom = openDom('<p>', { runScripts: 'outside-only' });
  const data = new TextEncoder().encode('synthetic csrf token');
  const expected = new Uint8Array(await webcrypto.subtle.digest('SHA-256', data));
  const busy = Array.from({ length: 8 }, () => new Promise(resolve => pbkdf2('x', 'y', 200_000, 32, 'sha256', resolve)));
  let digest = null;
  dom.window.crypto.subtle.digest('SHA-256', data).then(value => { digest = new Uint8Array(value); });
  for (let turn = 0; turn < 8 && !digest; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(digest, expected);
  await Promise.all(busy);
});

test('layout is measured after entrance animations finish', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    await session.send('Animation.enable');
    await session.send('Animation.setPlaybackRate', { playbackRate: 0 });
    await page.setContent('<style>@keyframes grow{from{height:20px}to{height:44px}}button{height:44px;animation:grow .4s linear}</style><button>Go</button>');
    await page.evaluate(async () => {
      const [animation] = document.getAnimations();
      await animation.ready;
      animation.currentTime = 200;
      const getAnimations = document.getAnimations.bind(document);
      document.getAnimations = () => { window.settleStarted = true; return getAnimations(); };
    });
    const height = () => page.locator('button').evaluate(el => el.getBoundingClientRect().height);
    await delay(600); // Measurement must tolerate a descheduled caller.
    assert.ok(await height() < 44, 'mid-animation the target is still undersized');
    let completed = false;
    const waiting = animationsSettled(page).then(() => { completed = true; });
    await page.waitForFunction(() => window.settleStarted);
    assert.equal(completed, false, 'layout waits while the animation is held');
    await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
    await waiting;
    assert.equal(await height(), 44);
  } finally { await browser.close(); }
});

test('a stalled async predicate fails at the wait call and releases its timer', async () => {
  const browser = await chromium.launch();
  let wait;
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<p>loaded</p>' }));
    let requested;
    const requestStarted = new Promise(resolve => { requested = resolve; });
    await page.route('http://localhost/stalled.mjs', () => requested());
    await page.goto('http://localhost/');
    wait = waitForAsync(page, async () => Boolean(await import('/stalled.mjs')), undefined, 100)
      .then(() => 'unexpected success', error => error);
    await requestStarted;
    const controller = new AbortController();
    try {
      const outcome = await Promise.race([wait, delay(1_000, 'still pending', { signal: controller.signal })]);
      assert.match(String(outcome), /waitForAsync:.*100 ms.*stalled.mjs/s);
      assert.equal(await page.evaluate(() => 2 + 2), 4, 'the timeout keeps the page usable');
    } finally { controller.abort(); }
  } finally {
    await browser.close();
    await wait;
  }
});

test('the after-hook closes successful browsers even when a cached launch rejected', async () => {
  const harness = new URL('./browser-harness.mjs', import.meta.url).href;
  const script = `
    import { after, test } from 'node:test';
    import assert from 'node:assert/strict';
    import { chromium } from ${JSON.stringify(harness)};
    let underlying;
    test('failed then successful launch', async () => {
      await assert.rejects(chromium.launch({ executablePath: '/__review_missing_chromium__' }));
      const lease = await chromium.launch();
      underlying = (await lease.newPage()).context().browser();
      await lease.close();
      assert.equal(underlying.isConnected(), true);
    });
    after(async () => {
      const connected = underlying.isConnected();
      await underlying.close(); // Clean up even when the harness regresses.
      assert.equal(connected, false, 'the harness after-hook must close the successful browser');
    });
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { timeout: 30_000 });
});

test('async waits bound false predicates and preserve evaluation failures', async () => {
  await assert.rejects(waitForAsync({ evaluate: async () => false }, () => false, undefined, 25),
    /waitForAsync: condition not met after 25 ms/);
  const failure = new Error('predicate failed');
  await assert.rejects(waitForAsync({ evaluate: async () => { throw failure; } }, () => false),
    error => error === failure);
});

test('a page never waits on the outside network', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const refused = [];
    page.on('requestfailed', request => refused.push(new URL(request.url()).hostname));
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans"><p>loaded</p>' }));
    await page.goto('http://localhost/');
    assert.deepEqual(refused, ['fonts.googleapis.com']);
  } finally { await browser.close(); }
});
