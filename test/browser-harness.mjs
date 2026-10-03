// The one way browser tests get Chromium, a wait budget and a fake clock.
//
// Hosted CI runs three test files at once on a four-vCPU runner. Launching a
// fresh Chromium for every test and giving each file its own 1-7 s wait budget
// made any wait that needed a little longer fail at random. Here:
//  - each test process keeps one Chromium; every launch() hands out its own
//    browser contexts, so storage, routes, clock and viewport stay per test;
//  - every page waits up to WAIT_MS for a condition before it fails, and no
//    request leaves the machine unless the test routes it;
//  - BROWSER_CPU_THROTTLE=<n> slows every page n times (CDP emulation) and
//    BROWSER_ROUTE_JITTER_MS=<ms> answers each routed request up to <ms> late,
//    so a CI-starved runner can be reproduced locally.
import { after } from 'node:test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium as playwright } from 'playwright';

export const WAIT_MS = 30_000;
const throttle = Number(process.env.BROWSER_CPU_THROTTLE || 1);
const jitter = Number(process.env.BROWSER_ROUTE_JITTER_MS || 0);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const launched = new Map();

after(async () => {
  const browsers = await Promise.all(launched.values());
  launched.clear();
  await Promise.all(browsers.map(browser => browser.close()));
});

export const chromium = {
  async launch(options = {}) {
    const key = JSON.stringify(options);
    if (!launched.has(key)) launched.set(key, playwright.launch(options));
    const browser = await launched.get(key);
    const contexts = new Set();
    return {
      async newPage(options = {}) {
        const context = await browser.newContext(options);
        contexts.add(context);
        context.setDefaultTimeout(WAIT_MS);
        // Tests never reach the network. A page's Google Fonts link held its
        // load event, and so page.goto, until an outside server answered. A
        // request a test does not route itself and that leaves this machine is refused.
        await context.route(url => !LOOPBACK.has(url.hostname), route => route.abort().catch(() => {}));
        const page = await context.newPage();
        if (throttle > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
        if (jitter > 0) {
          const route = page.route.bind(page);
          page.route = (url, handler, options) => route(url, async (...args) => { await delay(Math.random() * jitter); return handler(...args); }, options);
        }
        return page;
      },
      async close() {
        const open = [...contexts];
        contexts.clear();
        await Promise.all(open.map(context => context.close()));
      },
    };
  },
};

// Starts scripts/serve.mjs on a port the OS picks. A port drawn at random from
// a fixed range can be taken by a parallel run or an ephemeral connection.
export async function fixtureServer() {
  const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((resolve, reject) => {
    server.stdout.once('data', data => resolve(String(data).match(/http:\/\/[\d.]+:\d+/)[0]));
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`fixture server exited ${code}`)));
  });
  return { origin, close: () => server.kill() };
}

// page.waitForFunction treats a returned promise as truthy, so an async
// predicate (one that imports an app module to read its state) returns at once
// without waiting. This evaluates the predicate to completion until it holds.
export async function waitForAsync(page, predicate, arg) {
  const deadline = Date.now() + WAIT_MS;
  while (!(await page.evaluate(predicate, arg))) {
    if (Date.now() >= deadline) throw new Error(`waitForAsync: still false after ${WAIT_MS} ms: ${predicate}`);
    await delay(25);
  }
}

// Reruns `check` until its assertions pass, for the same budget as every page
// wait, then rethrows the last failure: the web-first form of "sleep, then
// assert" for state that arrives asynchronously (a held request, a reread).
export async function settles(check, budgetMs = WAIT_MS) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; }
    await delay(25);
  }
}

// A layout read during an entrance animation sees transformed, fractional
// boxes (a 44px target measures 43.6px mid-slide). Wait for every running,
// finite animation to finish before measuring; paused and endless ones stay.
export async function animationsSettled(page) {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))
    .map(animation => animation.finished.catch(() => {}))));
}

// A clock that stays at `time` until the test advances it. Installing at
// `time` and then pausing races the wall clock: any real millisecond between
// the two calls makes pauseAt(time) a step into the past. Install at the epoch
// before the page has timers, then jump forward.
export async function pausedClock(page, time) {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(time);
}
