import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IDLE_CUTOFF_MS, MIN_POLL_MS, mountLocalClock, mountVisibilityPoll } from '../js/visibility-poll.mjs';
import { mountAutoRefresh } from '../js/auto-refresh.mjs';

function page() {
  const document = new EventTarget(); document.visibilityState = 'visible';
  const window = new EventTarget(); const pending = new Map(); let next = 0, time = 0;
  window.setTimeout = (fn, ms) => { pending.set(++next, { fn, ms }); return next; };
  window.clearTimeout = id => pending.delete(id);
  return {
    document, window, now: () => time,
    advance(ms) { time += ms; },
    tick() { const jobs = [...pending.values()]; pending.clear(); jobs.forEach(job => job.fn()); },
    get count() { return pending.size; },
    get delays() { return [...pending.values()].map(job => job.ms); },
    hide() { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); },
    show() { document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); },
    input(type = 'pointerdown') { document.dispatchEvent(new Event(type)); },
  };
}
const settle = async () => { for (let i = 0; i < 10; ++i) await Promise.resolve(); };
const poller = (p, options = {}) => {
  const calls = { polls: 0 };
  const handle = mountVisibilityPoll({ document: p.document, window: p.window, now: p.now, intervalMs: 1400, poll: () => { calls.polls++; }, ...options });
  return Object.assign(calls, { handle });
};

test('the idle cutoff is thirty minutes', () => {
  assert.equal(IDLE_CUTOFF_MS, 30 * 60 * 1000);
});

test('hidden stops every network poller: no timer left and no call made', async () => {
  const p = page();
  const fixed = poller(p);
  let reads = 0;
  const auto = mountAutoRefresh({ document: p.document, window: p.window, now: p.now, refresh: () => { reads++; } });
  assert.equal(p.count, 2, 'one timer per poller while visible');
  p.tick(); await settle();
  assert.equal(fixed.polls, 1); assert.equal(reads, 1);
  p.hide();
  assert.equal(p.count, 0, 'going hidden clears the timers themselves');
  for (let i = 0; i < 5; ++i) { p.advance(60_000); p.tick(); await settle(); }
  assert.equal(fixed.polls, 1); assert.equal(reads, 1);
  fixed.handle.dispose(); auto.dispose();
});

test('a poll in flight when the tab hides does not re-arm the clock', async () => {
  const p = page(); let release;
  const handle = mountVisibilityPoll({ document: p.document, window: p.window, now: p.now, intervalMs: 1400, poll: () => new Promise(resolve => { release = resolve; }) });
  p.tick(); await settle(); p.hide(); release(); await settle();
  assert.equal(p.count, 0);
  handle.dispose();
});

test('returning to view refreshes once at once, then resumes the cadence', async () => {
  const p = page(); const fixed = poller(p);
  let reads = 0;
  const auto = mountAutoRefresh({ document: p.document, window: p.window, now: p.now, intervalMs: 15_000, refresh: () => { reads++; } });
  p.hide(); p.advance(8 * 3600_000);
  p.show(); await settle();
  assert.equal(fixed.polls, 1, 'one immediate poll on return'); assert.equal(reads, 1, 'one immediate read on return');
  assert.deepEqual(p.delays, [60_000, 60_000], 'then each poller is back on the one-minute cadence');
  p.tick(); await settle();
  assert.equal(fixed.polls, 2); assert.equal(reads, 2);
  fixed.handle.dispose(); auto.dispose();
});

test('idle for the cutoff pauses polling until the next input, which refreshes at once', async () => {
  const p = page(); const fixed = poller(p);
  let reads = 0;
  const auto = mountAutoRefresh({ document: p.document, window: p.window, now: p.now, refresh: () => { reads++; } });
  p.advance(IDLE_CUTOFF_MS - 1); p.tick(); await settle();
  assert.equal(fixed.polls, 1, 'still active a moment before the cutoff'); assert.equal(reads, 1);
  p.advance(1); p.tick(); await settle();
  assert.equal(fixed.polls, 1, 'no poll once idle'); assert.equal(reads, 1, 'no read once idle');
  assert.equal(p.count, 0, 'idle stops the timers, it does not keep ticking');
  p.advance(3600_000); p.tick(); await settle();
  assert.equal(fixed.polls, 1); assert.equal(reads, 1);
  p.input('keydown'); await settle();
  assert.equal(fixed.polls, 2, 'the first input polls at once'); assert.equal(reads, 2, 'the first input reads at once');
  assert.equal(p.count, 2, 'and re-arms each cadence');
  p.input('pointermove'); p.input('scroll'); await settle();
  assert.equal(fixed.polls, 2, 'later input while active does not poll again'); assert.equal(reads, 2);
  fixed.handle.dispose(); auto.dispose();
});

test('a manual refresh after the idle cutoff reads once, as before the pause; the clock still does not', async () => {
  const p = page(); let reads = 0;
  const auto = mountAutoRefresh({ document: p.document, window: p.window, now: p.now, refresh: () => { reads++; } });
  p.advance(IDLE_CUTOFF_MS); p.tick(); await settle();
  assert.equal(reads, 0, 'the timer issues no read once idle'); assert.equal(p.count, 0);
  await auto.poll(); assert.equal(reads, 0, 'nor does a page clock calling poll()');
  await auto.refresh(); await settle();
  assert.equal(reads, 1, 'the refresh button reads exactly once');
  assert.equal(p.count, 1, 'and the person counts as present, so the cadence re-arms');
  auto.dispose();
});

test('the first input after idle in a visible tab only reads: the hidden-return hook never runs', async () => {
  const p = page(); let reads = 0, suspends = 0;
  const auto = mountAutoRefresh({ document: p.document, window: p.window, now: p.now, refresh: () => { reads++; }, onResume: () => { suspends++; } });
  p.advance(IDLE_CUTOFF_MS); p.tick(); await settle();
  assert.equal(reads, 0);
  p.input('pointermove'); await settle();
  assert.equal(reads, 1, 'the wake reads exactly once');
  assert.equal(suspends, 0, 'and never closes the private view (leads suspendPrivateView)');
  p.hide(); p.show(); await settle();
  assert.equal(suspends, 1, 'a real return from hidden still runs the hook');
  auto.dispose();
});

test('a local clock keeps repainting while idle; only its read sleeps', async () => {
  const p = page(); let ticks = 0, reads = 0; const intervals = [];
  const clock = mountLocalClock({ document: p.document, window: p.window, now: p.now, intervalMs: 5000,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval: () => {},
    tick: () => { ticks++; }, read: () => { reads++; } });
  assert.deepEqual(intervals.map(job => job.ms), [5000], 'the repaint keeps the 5s cadence');
  p.advance(IDLE_CUTOFF_MS); p.tick(); await settle();
  assert.equal(reads, 0, 'idle: the read does not run');
  assert.equal(p.count, 0, 'and its timer is not re-armed');
  intervals[0].fn(); intervals[0].fn();
  assert.equal(ticks, 2, 'idle: the local repaint still runs');
  p.input(); await settle();
  assert.equal(reads, 1, 'the first input reads once');
  clock.dispose();
  const home = await readFile(new URL('../js/workspace-command-center.js', import.meta.url), 'utf8');
  assert.match(home, /const expiry = window\.setInterval\(\(\) => \{[^]*?render\(\);\s*auto\.poll\(\);/,
    'Home repaints an expired snapshot locally; its re-read is the gated poll, never an ungated refresh');
});

test('input keeps a visible tab active past the cutoff', async () => {
  const p = page(); const fixed = poller(p);
  for (let i = 0; i < 4; ++i) { p.advance(20 * 60_000); p.input('touchstart'); p.tick(); await settle(); }
  assert.equal(fixed.polls, 4);
  fixed.handle.dispose();
});

test('keepAlive (an active call) polls hidden and idle at its own rate, and stops when the call ends', async () => {
  const p = page(); let call = true;
  const fixed = poller(p, { intervalMs: 1600, keepAlive: () => call });
  p.hide();
  assert.deepEqual(p.delays, [1600], 'hiding does not clear a live call poll');
  p.advance(IDLE_CUTOFF_MS); p.tick(); await settle();
  assert.equal(fixed.polls, 1, 'hidden and idle, the call poll still reads');
  assert.deepEqual(p.delays, [1600]);
  call = false; p.tick(); await settle();
  assert.equal(fixed.polls, 1); assert.equal(p.count, 0, 'once the call ends the hidden poll stops');
  fixed.handle.dispose();
});

test('repeated hide and show leaves exactly one timer per poller', async () => {
  const p = page(); let release = null; let polls = 0;
  const handle = mountVisibilityPoll({ document: p.document, window: p.window, now: p.now, intervalMs: 1400,
    poll: () => { polls++; return new Promise(resolve => { release = resolve; }); } });
  for (let i = 0; i < 5; ++i) { p.hide(); p.show(); await settle(); }
  assert.equal(polls, 1, 'returns during an open read do not stack reads');
  assert.equal(p.count, 0);
  release(); await settle();
  assert.equal(polls, 2, 'the queued return reads once when the open read settles');
  release(); await settle();
  assert.equal(p.count, 1, 'reads that settle late never arm a second timer');
  for (let i = 0; i < 3; ++i) { p.input(); p.input('wheel'); }
  await settle();
  assert.equal(p.count, 1);
  handle.dispose();
  assert.equal(p.count, 0);
  p.show(); p.input(); await settle();
  assert.equal(polls, 2, 'a disposed poller never reads again');
});

test('every network poller in the app goes through the shared helper', async () => {
  const read = file => readFile(new URL(`../js/${file}`, import.meta.url), 'utf8');
  for (const file of ['app.js', 'pipeline.js', 'observatory.js', 'progress-board.js',
    'progress-wire.js', 'progress-work.js', 'queue.js', 'call-mode.js']) {
    const source = await read(file);
    assert.match(source, /mountVisibilityPoll\(|mountLocalClock\(/, `${file} polls through the helper`);
    assert.doesNotMatch(source, /document\.hidden \?|POLL_HIDDEN_MS/, `${file} has no hidden-tab cadence of its own`);
  }
  assert.doesNotMatch(await read('app.js'), /setInterval\(/, 'app.js keeps no raw interval');
  const pipeline = await read('pipeline.js');
  assert.doesNotMatch(pipeline, /setInterval\([^;]*(pollOnce|requestRefresh|refreshPanel)/, 'pipeline.js has no raw network interval');
  assert.equal(pipeline.match(/mountVisibilityPoll\(\{/g).length, 3, 'pipeline.js: panel, feed and board clocks');
  assert.doesNotMatch(await read('observatory.js'), /setInterval\(/);
  assert.match(await read('auto-refresh.mjs'), /watchPresence\(/, 'auto-refresh shares the same hidden and idle gate');
});

test('background refresh never runs faster than once a minute', () => {
  const p = page();
  assert.equal(MIN_POLL_MS, 60_000);
  const fixed = poller(p, { intervalMs: 1400 });
  assert.deepEqual(p.delays, [60_000], 'a 1.4 s poll arms at the one-minute floor');
  fixed.handle.dispose();
  const auto = mountAutoRefresh({ document: p.document, window: p.window, now: p.now, intervalMs: 30_000, refresh: () => {} });
  assert.deepEqual(p.delays, [60_000], 'a 30 s auto-refresh arms at the one-minute floor');
  auto.dispose();
  const call = poller(p, { intervalMs: 1600, keepAlive: () => true });
  assert.deepEqual(p.delays, [1600], 'a keepAlive poll keeps its own interval');
  call.handle.dispose();
});
