import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IDLE_CUTOFF_MS, mountLocalClock, mountVisibilityPoll } from '../js/visibility-poll.mjs';
import { mountAutoRefresh } from '../js/auto-refresh.mjs';

function page() {
  const document = new EventTarget(); document.visibilityState = 'visible';
  const window = new EventTarget(); const pending = new Map(); let next = 0, time = 0;
  window.setTimeout = (fn, ms) => { pending.set(++next, { fn, ms, at: time + ms }); return next; };
  window.clearTimeout = id => pending.delete(id);
  return {
    document, window, now: () => time,
    advance(ms) { time += ms; },
    async tick() {
      const jobs = [...pending].sort((a, b) => a[1].at - b[1].at);
      for (const [id, job] of jobs) {
        if (!pending.has(id)) continue;
        pending.delete(id); time = Math.max(time, job.at); job.fn(); await settle();
      }
    },
    get count() { return pending.size; },
    get delays() { return [...pending.values()].map(job => job.ms); },
    hide() { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); },
    show() { document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); },
    input(type = 'pointerdown') { document.dispatchEvent(new Event(type)); },
  };
}
const settle = async () => { for (let i = 0; i < 80; ++i) await Promise.resolve(); };
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
  await p.tick(); await settle();
  assert.equal(fixed.polls, 1); assert.equal(reads, 1);
  p.hide();
  assert.equal(p.count, 0, 'going hidden clears the timers themselves');
  for (let i = 0; i < 5; ++i) { p.advance(60_000); await p.tick(); await settle(); }
  assert.equal(fixed.polls, 1); assert.equal(reads, 1);
  fixed.handle.dispose(); auto.dispose();
});

test('a poll in flight when the tab hides does not re-arm the clock', async () => {
  const p = page(); let release;
  const handle = mountVisibilityPoll({ document: p.document, window: p.window, now: p.now, intervalMs: 1400, poll: () => new Promise(resolve => { release = resolve; }) });
  await p.tick(); await settle(); p.hide(); release(); await settle();
  assert.equal(p.count, 0);
  handle.dispose();
});

test('returning to view admits one shared immediate cycle, then resumes each cadence', async () => {
  const p = page(); const fixed = poller(p);
  let reads = 0;
  const auto = mountAutoRefresh({ document: p.document, window: p.window, now: p.now, intervalMs: 15_000, refresh: () => { reads++; } });
  p.hide(); p.advance(8 * 3600_000);
  p.show(); await settle();
  assert.equal(fixed.polls, 1, 'one immediate poll on return'); assert.equal(reads, 0, 'the simultaneous auto-refresh waits for the shared gap');
  assert.deepEqual(p.delays.sort((a, b) => a - b), [5000, 5000], 'the faster poller also honors the shared five-second gap');
  await p.tick(); await settle();
  assert.equal(fixed.polls, 1); assert.equal(reads, 1);
  await p.tick(); await settle();
  assert.equal(fixed.polls, 2);
  fixed.handle.dispose(); auto.dispose();
});

for (const kind of ['visibility poll', 'auto-refresh']) test(`${kind} sleeps at the idle cutoff and wakes once on input`, async () => {
  const p = page(); let reads = 0;
  const handle = kind === 'auto-refresh'
    ? mountAutoRefresh({ ...p, refresh() { reads++; } })
    : mountVisibilityPoll({ ...p, intervalMs: 1400, poll() { reads++; } });
  p.advance(IDLE_CUTOFF_MS - 1); await p.tick();
  assert.equal(reads, 1, 'still active before the cutoff');
  p.advance(1); await p.tick();
  assert.equal(reads, 1, 'idle makes no read'); assert.equal(p.count, 0);
  p.advance(3600_000); await p.tick(); assert.equal(reads, 1);
  p.input('keydown'); await settle();
  assert.equal(reads, 2, 'the first input reads once'); assert.equal(p.count, 1);
  p.input('pointermove'); p.input('scroll'); await settle(); assert.equal(reads, 2);
  handle.dispose();
});

test('a manual refresh after the idle cutoff reads once, as before the pause; the clock still does not', async () => {
  const p = page(); let reads = 0;
  const auto = mountAutoRefresh({ document: p.document, window: p.window, now: p.now, refresh: () => { reads++; } });
  p.advance(IDLE_CUTOFF_MS); await p.tick(); await settle();
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
  p.advance(IDLE_CUTOFF_MS); await p.tick(); await settle();
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
  p.advance(IDLE_CUTOFF_MS); await p.tick(); await settle();
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
  for (let i = 0; i < 4; ++i) { p.advance(20 * 60_000); p.input('touchstart'); await p.tick(); await settle(); }
  assert.equal(fixed.polls, 4);
  fixed.handle.dispose();
});

test('keepAlive (an active call) polls hidden and idle at its own rate, and stops when the call ends', async () => {
  const p = page(); let call = true;
  const fixed = poller(p, { intervalMs: 1600, keepAlive: () => call });
  p.hide();
  assert.deepEqual(p.delays, [1600], 'hiding does not clear a live call poll');
  p.advance(IDLE_CUTOFF_MS); await p.tick(); await settle();
  assert.equal(fixed.polls, 1, 'hidden and idle, the call poll still reads');
  assert.deepEqual(p.delays, [5000], 'an active call also honors the shared minimum gap');
  call = false; await p.tick(); await settle();
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
  p.advance(5000); release(); await settle();
  assert.equal(polls, 2, 'the queued return reads once after the open read and shared gap settle');
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
