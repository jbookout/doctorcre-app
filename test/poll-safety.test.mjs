import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAutoRefresh } from '../js/auto-refresh.mjs';

export function fakeClock() {
  let time = 0, id = 0;
  const jobs = new Map();
  const window = new EventTarget();
  const document = new EventTarget(); document.visibilityState = 'visible';
  window.setTimeout = (fn, ms) => { jobs.set(++id, { fn, at: time + ms }); return id; };
  window.clearTimeout = key => jobs.delete(key);
  const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
  return { window, document, now: () => time, settle,
    async advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; jobs.delete(next[0]); next[1].fn(); await settle();
      }
      time = end; await settle();
    },
  };
}

test('failure retries slow above the interval and stop after three failures', async () => {
  const c = fakeClock(), times = [];
  const auto = mountAutoRefresh({ ...c, intervalMs: 30_000, refresh() { times.push(c.now()); throw Error('outage'); } });
  await c.advance(30_000); await c.advance(59_999);
  assert.deepEqual(times, [30_000], 'failure must not retry sooner than twice the interval');
  await c.advance(1); await c.advance(120_000); await c.advance(600_000);
  assert.deepEqual(times, [30_000, 90_000, 210_000]);
  auto.dispose();
});

test('online and visibility storms share a minimum gap with the timer', async () => {
  const c = fakeClock(); let requests = 0;
  const auto = mountAutoRefresh({ ...c, refresh() { requests++; } });
  for (let i = 0; i < 100; i++) {
    c.window.dispatchEvent(new Event('online'));
    c.document.visibilityState = 'hidden'; c.document.dispatchEvent(new Event('visibilitychange'));
    c.document.visibilityState = 'visible'; c.document.dispatchEvent(new Event('visibilitychange'));
    await c.settle();
  }
  assert.equal(requests, 1);
  await c.advance(5_000);
  c.window.dispatchEvent(new Event('online')); await c.settle();
  assert.equal(requests, 2);
  auto.dispose();
});

test('the physical fetch budget pauses before request 61 and cannot be reset by resume', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety(c); let requests = 0;
  const transport = async () => { requests++; return new Response('{}'); };
  for (let i = 0; i < 60; i++) await safety.fetch(transport, '/mcp');
  await assert.rejects(safety.fetch(transport, '/mcp'));
  assert.equal(requests, 60);
  assert.equal(safety.state().paused, true);
  safety.resume();
  await assert.rejects(safety.fetch(transport, '/mcp'));
  assert.equal(requests, 60);
  safety.dispose();
});

for (const retryAfter of ['600', 'Thu, 01 Jan 1970 00:10:00 GMT']) test(`429 Retry-After ${retryAfter} gates every trigger and manual refresh`, async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety(c); let requests = 0;
  const transport = async () => { requests++; return new Response('', { status: 429, headers: { 'Retry-After': retryAfter } }); };
  await safety.run(() => safety.fetch(transport, '/mcp'));
  await c.advance(300_000);
  await safety.run(() => safety.fetch(transport, '/mcp'), { manual: true });
  assert.equal(requests, 1, 'longer Retry-After also holds a manual attempt');
  await c.advance(300_000);
  await safety.run(() => safety.fetch(transport, '/mcp'));
  assert.equal(requests, 2);
  safety.dispose();
});

test('a failing endpoint pauses even when sibling reads succeed and errors are caught by the page', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety(c); let requests = 0;
  const transport = async path => { requests++; return new Response('{}', { status: path === '/bad' ? 503 : 200 }); };
  const read = () => safety.run(async () => {
    await Promise.all(['/bad', '/good', '/other'].map(path => safety.fetch(transport, path).catch(() => {})));
  }, { intervalMs: 30_000 });
  await read(); await c.advance(60_000); await read(); await c.advance(120_000); await read();
  assert.equal(safety.state().paused, true);
  const before = requests;
  await c.advance(24 * 3600_000); await read();
  assert.equal(requests, before);
  safety.dispose();
});

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function lockManager() {
  let held = false;
  return { async request(_name, _options, callback) {
    if (held) return callback(null);
    held = true;
    try { return await callback({ name: 'polling' }); }
    finally { held = false; }
  } };
}

test('ten tabs and multiple pollers make one five-read cycle, including all session checks', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const { createSessionBoundary } = await import('../js/private-session.js');
  const c = fakeClock(), locks = lockManager(); let requests = 0;
  const tabs = Array.from({ length: 10 }, () => {
    const tab = fakeClock(); tab.window.navigator = { locks }; tab.window.sessionStorage = storage();
    const safety = createPollSafety({ ...tab, now: c.now, locks, storage: tab.window.sessionStorage });
    const client = createSessionBoundary({ safety, invalidate() {}, fetchImpl: async path => {
      requests++;
      return Response.json(path === '/auth/session' ? { actor: { slug: 'synthetic' }, csrf_token: 'synthetic-fixture' } : {});
    } });
    return { ...tab, safety, read: () => safety.run(() => Promise.all(Array.from({ length: 5 }, () => client.fetch('/read')))) };
  });
  await Promise.all(tabs.flatMap(tab => Array.from({ length: 4 }, tab.read)));
  assert.equal(requests, 15, 'one owner, five payloads and ten session verifications');
  tabs[0].document.visibilityState = 'hidden'; tabs[0].document.dispatchEvent(new Event('visibilitychange')); await c.settle();
  await c.advance(30_000); await tabs[1].read();
  assert.equal(requests, 30, 'another tab takes over after the owner hides');
  tabs.forEach(tab => tab.safety.dispose());
});

test('reload preserves a spent budget and sticky pause', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), saved = storage(); let requests = 0;
  const transport = async () => { requests++; return new Response('{}'); };
  const first = createPollSafety({ ...c, storage: saved });
  for (let i = 0; i < 60; i++) await first.fetch(transport, '/read');
  await first.fetch(transport, '/read').catch(() => {}); first.dispose();
  const next = createPollSafety({ ...c, storage: saved });
  await next.fetch(transport, '/read').catch(() => {});
  assert.equal(requests, 60);
  assert.equal(next.state().paused, true);
  next.dispose();
});

test('a visible page left open for 24 hours stops at 300 requests despite input and event storms', async () => {
  const { pollSafety } = await import('../js/poll-safety.mjs');
  const { mountVisibilityPoll } = await import('../js/visibility-poll.mjs');
  const c = fakeClock(), safety = pollSafety(c.window, c); let requests = 0;
  const transport = async () => { requests++; return new Response('{}'); };
  const read = () => Promise.all(Array.from({ length: 5 }, () => safety.fetch(transport, '/read')));
  const auto = mountAutoRefresh({ ...c, refresh: read, intervalMs: 15_000 });
  const other = mountVisibilityPoll({ ...c, poll: read, intervalMs: 30_000 });
  for (let minute = 0; minute < 1440; minute++) {
    c.document.dispatchEvent(new Event('pointermove'));
    await c.advance(60_000);
    for (let flap = 0; flap < 10; flap++) { c.window.dispatchEvent(new Event('online')); await c.settle(); }
  }
  assert.equal(requests, 300, 'no human resume means an hourly-budget pause lasts all day');
  assert.equal(safety.state().paused, true);
  auto.dispose(); other.dispose(); safety.dispose();
});

test('hourly resume never exceeds 7200 background requests in a half-open 24-hour window', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety(c); let requests = 0;
  const transport = async () => { requests++; return new Response('{}'); };
  for (let hour = 0; hour < 24; hour++) {
    safety.resume();
    for (let minute = 0; minute < 10; minute++) {
      for (let request = 0; request < 30; request++) await safety.fetch(transport, '/read');
      await c.advance(60_000);
    }
    await assert.rejects(safety.fetch(transport, '/read'));
    await c.advance(50 * 60_000);
  }
  assert.equal(requests, 7200);
  safety.dispose();
});

test('manual refresh still reads during a budget pause but has its own hard budget and trigger gap', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety(c); let requests = 0;
  const transport = async () => { requests++; return new Response('{}'); };
  for (let i = 0; i < 60; i++) await safety.fetch(transport, '/read');
  await safety.fetch(transport, '/read').catch(() => {});
  const manual = () => safety.run(() => safety.fetch(transport, '/read'), { manual: true });
  await manual(); await manual(); assert.equal(requests, 61);
  for (let i = 0; i < 3; i++) {
    await c.advance(60_000);
    await safety.run(() => Promise.all(Array.from({ length: 30 }, () => safety.fetch(transport, '/read'))), { manual: true });
  }
  await c.advance(60_000);
  await safety.run(() => Promise.all(Array.from({ length: 30 }, () => safety.fetch(transport, '/read'))), { manual: true });
  assert.equal(requests, 180, '60 background plus the separate 120/hour manual allowance');
  await c.advance(60_000); await manual(); assert.equal(requests, 180);
  safety.dispose();
});

test('successful independent pollers cannot clear another endpoint failure streak', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety(c);
  const transport = async path => new Response('{}', { status: path === '/bad' ? 503 : 200 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await safety.run(() => safety.fetch(transport, '/bad'));
    await c.advance(300_000);
    await safety.run(() => safety.fetch(transport, '/good'));
    await c.advance(300_000);
  }
  assert.equal(safety.state().paused, true);
  safety.dispose();
});

test('a manual write retains its counted allowance through post-write session verification', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const { createSessionBoundary } = await import('../js/private-session.js');
  const c = fakeClock(), activation = { isActive: false };
  const safety = createPollSafety({ ...c, locks: lockManager(), storage: storage() });
  c.window.navigator = { userActivation: activation };
  for (let i = 0; i < 60; i++) await safety.fetch(async () => new Response('{}'), '/read');
  await safety.fetch(async () => new Response('{}'), '/read').catch(() => {});
  let writes = 0, checks = 0;
  const client = createSessionBoundary({ safety, invalidate() {}, fetchImpl: async path => {
    if (path === '/auth/session') { checks++; return Response.json({ actor: { slug: 'synthetic' }, csrf_token: 'synthetic-fixture' }); }
    writes++; activation.isActive = false;
    return Response.json({ ok: true });
  } });
  activation.isActive = true;
  const response = await client.fetch('/write', { method: 'POST' });
  assert.equal(response.ok, true);
  assert.equal(writes, 1); assert.equal(checks, 2, 'both session checks count in the same manual operation');
  safety.dispose();
});

test('a manual mutation reserves both session checks before sending its payload', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const { createSessionBoundary } = await import('../js/private-session.js');
  const c = fakeClock(), safety = createPollSafety(c); let writes = 0;
  await safety.run(async () => {
    for (let i = 0; i < 28; i++) await safety.fetch(async () => new Response('{}'), '/read');
  }, { manual: true });
  await c.advance(5_000);
  const client = createSessionBoundary({ safety, invalidate() {}, fetchImpl: async path => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'synthetic' }, csrf_token: 'synthetic-fixture' });
    writes++; return Response.json({ ok: true });
  } });
  await safety.run(() => client.fetch('/write', { method: 'POST' }), { manual: true });
  assert.equal(writes, 0, 'insufficient capacity must refuse before sending a write');
  safety.dispose();
});

test('a visibility poller allows human refresh during pause but keeps timers background', async () => {
  const { pollSafety } = await import('../js/poll-safety.mjs');
  const { mountVisibilityPoll } = await import('../js/visibility-poll.mjs');
  const c = fakeClock(), safety = pollSafety(c.window, c); let requests = 0;
  const transport = async () => { requests++; return new Response('{}'); };
  const poller = mountVisibilityPoll({ ...c, intervalMs: 15_000, poll: () => safety.fetch(transport, '/read') });
  for (let i = 0; i < 60; i++) await safety.fetch(transport, '/read');
  await safety.fetch(transport, '/read').catch(() => {});
  c.window.navigator = { userActivation: { isActive: true } };
  await poller.refresh();
  assert.equal(requests, 61);
  await c.advance(15_000);
  assert.equal(requests, 61, 'transient activation cannot turn a timer into manual traffic');
  poller.dispose(); safety.dispose();
});

test('a queued first read rechecks draft protection before starting', async () => {
  const { pollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = pollSafety(c.window, c); let release, draft = false, reads = 0;
  const held = safety.run(() => new Promise(resolve => { release = resolve; }));
  await c.settle();
  const auto = mountAutoRefresh({ ...c, shouldRefresh: () => !draft, refresh() { reads++; } });
  const queued = auto.refresh();
  draft = true; release(); await held; await queued;
  assert.equal(reads, 0);
  auto.dispose(); safety.dispose();
});

test('background and human allowances together cannot exceed 10080 physical requests per tab per day', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety(c); let requests = 0;
  const transport = async () => { requests++; return new Response('{}'); };
  for (let hour = 0; hour < 24; hour++) {
    safety.resume();
    for (let minute = 0; minute < 10; minute++) {
      for (let request = 0; request < 30; request++) await safety.fetch(transport, '/read');
      await c.advance(60_000);
    }
    await safety.fetch(transport, '/read').catch(() => {});
    for (let minute = 0; minute < 4; minute++) {
      await safety.run(() => Promise.all(Array.from({ length: 30 }, () => safety.fetch(transport, '/read'))), { manual: true });
      await c.advance(60_000);
    }
    await c.advance(46 * 60_000);
  }
  assert.equal(requests, 10080);
  safety.dispose();
});

test('another poller trigger gap does not reject a page initial session read', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const { createSessionBoundary } = await import('../js/private-session.js');
  const c = fakeClock(), safety = createPollSafety(c); let requests = 0;
  await safety.run(() => {});
  const client = createSessionBoundary({ safety, invalidate() {}, fetchImpl: async path => {
    requests++; return Response.json(path === '/auth/session' ? { actor: { slug: 'synthetic' }, csrf_token: 'synthetic-fixture' } : {});
  } });
  assert.equal((await client.fetch('/initial')).ok, true);
  assert.equal(requests, 3);
  safety.dispose();
});

test('a fast poller cannot starve another page poller of its refresh turn', async () => {
  const c = fakeClock(); let fast = 0, slow = 0;
  const { mountVisibilityPoll } = await import('../js/visibility-poll.mjs');
  const a = mountVisibilityPoll({ ...c, intervalMs: 1_400, poll() { fast++; } });
  const b = mountAutoRefresh({ ...c, intervalMs: 15_000, refresh() { slow++; } });
  await c.advance(120_000);
  assert.ok(fast > 0);
  assert.ok(slow >= 4, 'each waiting poller must get a bounded turn while the tab is active');
  a.dispose(); b.dispose();
});

test('a queued background cooldown cannot block an eligible human refresh', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety(c); let requests = 0;
  await safety.run(() => { throw Error('outage'); });
  const transport = async () => { requests++; return new Response('{}'); };
  const background = safety.run(() => safety.fetch(transport, '/read'), { source: {} });
  const manual = safety.run(() => safety.fetch(transport, '/read'), { source: {}, manual: true });
  await c.settle();
  assert.equal(requests, 1, 'the manual allowance remains usable during automatic backoff');
  safety.dispose(); await background; await manual;
});

test('human refresh promotes its own queued background turn without waiting for backoff', async () => {
  const c = fakeClock(); let reads = 0;
  const auto = mountAutoRefresh({ ...c, refresh() { if (++reads === 1) throw Error('outage'); } });
  await auto.refresh(); await c.advance(1_000);
  c.window.dispatchEvent(new Event('online')); await c.settle();
  await c.advance(9_000);
  c.window.navigator = { userActivation: { isActive: true } };
  const manual = auto.refresh(); await c.settle();
  assert.equal(reads, 2);
  await manual; auto.dispose();
});
