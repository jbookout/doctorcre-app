// Keeps browser and JSDOM tests on their shared harnesses: the CI failures
// these replace came from per-test Chromium launches, per-file wait budgets of
// 1-7 s, a wall-clock pauseAt race and threadpool-bound hashing in settle().
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { pbkdf2, webcrypto } from 'node:crypto';
import { animationsSettled, chromium, pausedClock, settles, waitForAsync } from './browser-harness.mjs';
import { openDom } from './jsdom-harness.mjs';

const dir = new URL('./', import.meta.url);
// This file reproduces the patterns it forbids, so it scans every other test.
const sources = await Promise.all((await readdir(dir)).filter(name => /\.test\.mjs$/.test(name) && name !== 'test-harness.test.mjs')
  .map(async name => ({ name, text: await readFile(new URL(name, dir), 'utf8') })));

test('every browser test gets Chromium from the harness and waits on its one budget', () => {
  for (const { name, text } of sources) {
    assert.doesNotMatch(text, /from ['"]playwright['"]/, `${name} imports Playwright directly`);
    assert.doesNotMatch(text, /setDefaultTimeout\(/, `${name} sets its own wait budget`);
    assert.doesNotMatch(text, /[{,]\s*timeout\s*:\s*\d/, `${name} gives one wait its own budget`);
    assert.doesNotMatch(text, /waitForFunction\(\s*async/, `${name} waits on an async predicate, which never waits`);
    assert.doesNotMatch(text, /for\s*\(\s*let \w+\s*=\s*0;[^;]*;\s*\w+\+\+\s*\)\s*await page\.waitForTimeout/, `${name} polls with its own fixed budget`);
  }
});

test('an async predicate is awaited to completion, unlike waitForFunction', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<p>loaded</p>');
    await page.evaluate(() => { window.ready = false; setTimeout(() => { window.ready = true; }, 300); });
    await page.waitForFunction(async () => window.ready);
    assert.equal(await page.evaluate(() => window.ready), false, 'waitForFunction returned before its async predicate held');
    await waitForAsync(page, async () => window.ready);
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
    await page.setContent('<style>@keyframes grow{from{height:20px}to{height:44px}}button{height:44px;animation:grow .4s linear}</style><button>Go</button>');
    const height = () => page.locator('button').evaluate(el => el.getBoundingClientRect().height);
    assert.ok(await height() < 44, 'mid-animation the target is still undersized');
    await animationsSettled(page);
    assert.equal(await height(), 44);
  } finally { await browser.close(); }
});
