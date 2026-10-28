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

test('the physical fetch budget stops runaway traffic and grants one bounded recovery allowance', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety(c); let requests = 0;
  const transport = async () => { requests++; return new Response('{}'); };
  for (let i = 0; i < 90; i++) await safety.fetch(transport, '/mcp', undefined, { manual: false });
  await assert.rejects(safety.fetch(transport, '/mcp', undefined, { manual: false }));
  assert.equal(requests, 90);
  assert.equal(safety.state().paused, true);
  await safety.resume();
  for (let i = 0; i < 30; i++) await safety.fetch(transport, '/mcp', undefined, { manual: false });
  await assert.rejects(safety.fetch(transport, '/mcp', undefined, { manual: false }));
  await safety.resume();
  await assert.rejects(safety.fetch(transport, '/mcp', undefined, { manual: false }));
  assert.equal(requests, 120);
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
  await read(); await c.advance(120_000); await read(); await c.advance(120_000); await read();
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
  const held = new Set(), pending = new Map();
  return { async request(name, options, callback) {
    if (held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise(resolve => { const jobs = pending.get(name) || []; jobs.push(resolve); pending.set(name, jobs); });
    }
    held.add(name);
    try { return await callback({ name }); }
    finally {
      const next = pending.get(name)?.shift();
      if (next) next(); else held.delete(name);
    }
  } };
}

test('ten tabs coalesce duplicate cycle triggers and count all session checks', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const { createSessionBoundary } = await import('../js/private-session.js');
  const c = fakeClock(), locks = lockManager(), shared = storage(); let requests = 0;
  const tabs = Array.from({ length: 10 }, () => {
    const tab = fakeClock(); tab.window.navigator = { locks }; tab.window.localStorage = shared;
    const safety = createPollSafety({ ...tab, now: c.now, locks, storage: tab.window.localStorage });
    const client = createSessionBoundary({ safety, invalidate() {}, fetchImpl: async path => {
      requests++;
      return Response.json(path === '/auth/session' ? { actor: { slug: 'synthetic' }, csrf_token: 'synthetic-fixture' } : {});
    } });
    return { ...tab, safety, read: () => safety.run(() => Promise.all(Array.from({ length: 5 }, () => client.fetch('/read')))) };
  });
  await Promise.all(tabs.flatMap(tab => Array.from({ length: 4 }, tab.read)));
  assert.equal(requests, 15, 'one owner, five payloads and ten session verifications');
  tabs[0].document.visibilityState = 'hidden'; tabs[0].document.dispatchEvent(new Event('visibilitychange')); await c.settle();
  await c.advance(305_000); await tabs[1].read();
  assert.equal(requests, 30, 'another tab takes over after the owner hides');
  tabs.forEach(tab => tab.safety.dispose());
});

test('reload preserves a spent budget and sticky pause', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), saved = storage(); let requests = 0;
  const transport = async () => { requests++; return new Response('{}'); };
  const first = createPollSafety({ ...c, storage: saved });
  for (let i = 0; i < 90; i++) await first.fetch(transport, '/read', undefined, { manual: false });
  await first.fetch(transport, '/read', undefined, { manual: false }).catch(() => {}); first.dispose();
  const next = createPollSafety({ ...c, storage: saved });
  await next.fetch(transport, '/read', undefined, { manual: false }).catch(() => {});
  assert.equal(requests, 90);
  assert.equal(next.state().paused, true);
  next.dispose();
});

test('a visible page stays within its background allowance all day despite input and event storms', async () => {
  const { pollSafety } = await import('../js/poll-safety.mjs');
  const { mountVisibilityPoll } = await import('../js/visibility-poll.mjs');
  const c = fakeClock(), safety = pollSafety(c.window, c); let requests = 0;
  const sentAt = [];
  const transport = async () => { requests++; sentAt.push(c.now()); return new Response('{}'); };
  const read = () => Promise.all(Array.from({ length: 5 }, () => safety.fetch(transport, '/read')));
  const auto = mountAutoRefresh({ ...c, refresh: read, intervalMs: 15_000 });
  const other = mountVisibilityPoll({ ...c, poll: read, intervalMs: 30_000 });
  for (let minute = 0; minute < 1440; minute++) {
    c.document.dispatchEvent(new Event('pointermove'));
    await c.advance(60_000);
    for (let flap = 0; flap < 10; flap++) { c.window.dispatchEvent(new Event('online')); await c.settle(); }
  }
  assert.ok(requests > 4000, 'healthy refreshes continue throughout the day');
  for (let hour = 0; hour < 24; hour++) assert.ok(sentAt.filter(time => time >= hour * 3600_000 && time < (hour + 1) * 3600_000).length <= 240, 'each hour leaves margin below the hard ceiling');
  assert.equal(safety.state().paused, false);
  auto.dispose(); other.dispose(); safety.dispose();
});

test('repeated recovery attempts stay below 7920 background requests per browser per day', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety({ ...c, storage: storage() });
  const sentAt = [];
  const transport = async () => { sentAt.push(c.now()); return new Response('{}'); };
  for (let minute = 0; minute < 1440; minute++) {
    await safety.resume();
    for (let request = 0; request < 60; request++) await safety.fetch(transport, '/read', undefined, { manual: false }).catch(() => {});
    await c.advance(60_000);
  }
  assert.ok(sentAt.length > 300, 'recovery grants fresh allowance during a sustained outage');
  assert.ok(sentAt.length <= 7920, 'repeated resume cannot multiply the daily browser ceiling');
  for (let hour = 0; hour < 24; hour++) assert.ok(sentAt.filter(time => time >= hour * 3600_000 && time < (hour + 1) * 3600_000).length <= 330);
  safety.dispose();
});

test('manual refresh still reads during a budget pause but has its own hard budget and trigger gap', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety(c); let requests = 0;
  const transport = async () => { requests++; return new Response('{}'); };
  for (let i = 0; i < 90; i++) await safety.fetch(transport, '/read', undefined, { manual: false });
  await safety.fetch(transport, '/read', undefined, { manual: false }).catch(() => {});
  const manual = () => safety.run(() => safety.fetch(transport, '/read'), { manual: true });
  await manual(); await manual(); assert.equal(requests, 91);
  for (let i = 0; i < 4; i++) {
    await c.advance(60_000);
    await safety.run(() => Promise.all(Array.from({ length: 120 }, () => safety.fetch(transport, '/read'))), { manual: true });
  }
  await c.advance(60_000);
  await safety.run(() => Promise.all(Array.from({ length: 120 }, () => safety.fetch(transport, '/read'))), { manual: true });
  assert.equal(requests, 690, '90 background plus the separate 600/hour human allowance');
  await c.advance(60_000); await manual(); assert.equal(requests, 690);
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
  for (let i = 0; i < 90; i++) await safety.fetch(async () => new Response('{}'), '/read', undefined, { manual: false });
  await safety.fetch(async () => new Response('{}'), '/read', undefined, { manual: false }).catch(() => {});
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
    for (let i = 0; i < 118; i++) await safety.fetch(async () => new Response('{}'), '/read');
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
  for (let i = 0; i < 90; i++) await safety.fetch(transport, '/read', undefined, { manual: false });
  await safety.fetch(transport, '/read', undefined, { manual: false }).catch(() => {});
  c.window.navigator = { userActivation: { isActive: true } };
  await poller.refresh();
  assert.equal(requests, 91);
  await c.advance(15_000);
  assert.equal(requests, 91, 'transient activation cannot turn a timer into manual traffic');
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

test('background and human allowances together stay below 22320 physical requests per browser per day', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety({ ...c, storage: storage() }); let background = 0, human = 0;
  const transport = kind => async () => { if (kind === 'human') human++; else background++; return new Response('{}'); };
  for (let minute = 0; minute < 1440; minute++) {
    await safety.resume();
    for (let request = 0; request < 60; request++) await safety.fetch(transport('background'), '/read', undefined, { manual: false }).catch(() => {});
    if (minute % 60 < 5) await safety.run(() => Promise.all(Array.from({ length: 120 }, () => safety.fetch(transport('human'), '/read'))), { manual: true });
    await c.advance(60_000);
  }
  assert.ok(background > 300);
  assert.ok(background <= 7920);
  assert.equal(human, 14400, 'the separate human allowance remains usable throughout the background pauses');
  assert.ok(background + human <= 22320);
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
  await auto.poll(); await c.advance(1_000);
  c.window.dispatchEvent(new Event('online')); await c.settle();
  await c.advance(9_000);
  c.window.navigator = { userActivation: { isActive: true } };
  const manual = auto.refresh(); await c.settle();
  assert.equal(reads, 2);
  await manual; auto.dispose();
});

test('forty actual pollers across ten tabs share one leader and its physical budget', async () => {
  const { pollSafety } = await import('../js/poll-safety.mjs');
  const { createSessionBoundary } = await import('../js/private-session.js');
  const c = fakeClock(), locks = lockManager(), shared = storage(), counts = Array(10).fill(0);
  const tabs = counts.map((_, index) => {
    const document = new EventTarget(); document.visibilityState = 'visible';
    const window = new EventTarget();
    window.setTimeout = c.window.setTimeout; window.clearTimeout = c.window.clearTimeout;
    window.navigator = { locks }; window.localStorage = shared;
    const safety = pollSafety(window, { document, now: c.now });
    const client = createSessionBoundary({ safety, invalidate() {}, fetchImpl: async path => {
      counts[index]++;
      return Response.json(path === '/auth/session' ? { actor: { slug: 'synthetic' }, csrf_token: 'synthetic-fixture' } : {});
    } });
    const pollers = Array.from({ length: 4 }, () => mountAutoRefresh({ window, document, now: c.now,
      idleMs: Infinity, intervalMs: 15_000,
      refresh: () => Promise.all(Array.from({ length: 5 }, () => client.fetch('/read'))),
    }));
    return { window, document, safety, pollers };
  });
  await c.advance(3_600_000);
  assert.ok(counts.reduce((sum, count) => sum + count, 0) >= 150);
  assert.ok(counts.reduce((sum, count) => sum + count, 0) <= 240);
  assert.equal(counts.filter(count => count > 0).length, 1);
  assert.equal(tabs.find((_, index) => counts[index] > 0).safety.state().paused, false);
  tabs.forEach(tab => { tab.pollers.forEach(poller => poller.dispose()); tab.safety.dispose(); });
});

test('one failed secondary read cannot block a different view first read', async () => {
  const { pollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = pollSafety(c.window, c); let requests = 0;
  await safety.run(() => { throw Error('secondary outage'); });
  const auto = mountAutoRefresh({ ...c, refresh: () => safety.fetch(async () => { requests++; return new Response('{}'); }, '/primary') });
  const first = auto.refresh(); await c.settle();
  assert.equal(requests, 1, 'first initialization remains possible within the physical budget');
  await first;
  await safety.run(() => safety.fetch(async () => { requests++; return new Response('{}'); }, '/background'));
  assert.equal(requests, 1, 'ordinary background turns still honor the failure cooldown');
  auto.dispose(); safety.dispose();
});

test('raw page event handlers share the trigger gap without suppressing their callbacks', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const { createSessionBoundary } = await import('../js/private-session.js');
  const c = fakeClock(), safety = createPollSafety(c); let requests = 0, callbacks = 0;
  const client = createSessionBoundary({ safety, invalidate() {}, fetchImpl: async path => {
    requests++; return Response.json(path === '/auth/session' ? { actor: { slug: 'synthetic' }, csrf_token: 'synthetic-fixture' } : {});
  } });
  const read = () => { callbacks++; void client.fetch(`/raw?event=${callbacks}`).catch(() => {}); };
  c.window.addEventListener('online', read);
  c.document.addEventListener('visibilitychange', () => { if (c.document.visibilityState === 'visible') read(); });
  for (let i = 0; i < 100; i++) {
    c.window.dispatchEvent(new Event('online')); await c.settle();
    c.document.visibilityState = 'hidden'; c.document.dispatchEvent(new Event('visibilitychange'));
    c.document.visibilityState = 'visible'; c.document.dispatchEvent(new Event('visibilitychange')); await c.settle();
  }
  assert.equal(callbacks, 200, 'privacy and local view handlers always receive their events');
  assert.equal(requests, 3, 'only one logical authenticated read reaches the transport inside the gap');
  await c.advance(60_000); c.window.dispatchEvent(new Event('online')); await c.settle();
  assert.equal(requests, 6);
  safety.dispose();
});

test('a healthy poller cannot erase another poller failures on the same HTTP route', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety(c), bad = {}, good = {};
  const transport = async path => new Response('{}', { status: path.includes('bad') ? 503 : 200 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await safety.run(() => safety.fetch(transport, '/read?record=bad'), { source: bad });
    await c.advance(300_000);
    await safety.run(() => safety.fetch(transport, '/read?record=good'), { source: good });
    await c.advance(300_000);
  }
  assert.equal(safety.state().paused, true);
  safety.dispose();
});

test('failure notifications cannot continually postpone a healthy poller before it queues', async () => {
  const { pollSafety } = await import('../js/poll-safety.mjs');
  const { mountVisibilityPoll } = await import('../js/visibility-poll.mjs');
  const c = fakeClock(), safety = pollSafety(c.window, c); let healthyRequests = 0;
  const bad = mountVisibilityPoll({ ...c, intervalMs: 5_000, poll: () => safety.fetch(async () => new Response('{}', { status: 503 }), '/bad') });
  const good = mountAutoRefresh({ ...c, intervalMs: 15_000, refresh: () => safety.fetch(async () => { healthyRequests++; return new Response('{}'); }, '/good') });
  await c.advance(300_000);
  assert.ok(healthyRequests >= 1, 'healthy work must get a turn before the repeated-failure circuit opens');
  good.dispose(); bad.dispose(); safety.dispose();
});

test('round two: navigation and a delayed save survive the control room exhausting background reads', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const { createSessionBoundary } = await import('../js/private-session.js');
  const c = fakeClock(), saved = storage();
  let sent = 0;
  const fetchImpl = async path => {
    sent++;
    return Response.json(path === '/auth/session' ? { actor: { slug: 'synthetic' }, csrf_token: 'synthetic-fixture' } : { ok: true });
  };
  const first = createPollSafety({ ...c, storage: saved });
  const client = createSessionBoundary({ safety: first, invalidate() {}, fetchImpl });
  for (let cycle = 0; cycle < 41; cycle++) {
    await first.run(() => Promise.all(Array.from({ length: 5 }, () => client.fetch('/mcp').catch(() => {}))), { intervalMs: 15_000, initial: true });
    await c.advance(15_000);
  }
  assert.equal(sent, 300);
  assert.equal(c.now(), 615_000, 'the review reproduction reaches 10.25 minutes');
  assert.equal(first.state().paused, true);
  first.dispose();
  await c.advance(60_000);
  const next = createPollSafety({ ...c, storage: saved });
  const page = createSessionBoundary({ safety: next, invalidate() {}, fetchImpl });
  assert.equal((await page.fetch('/api/v1/deals')).ok, true, 'new document reads use the human allowance');
  await c.advance(6_000);
  assert.equal((await page.fetch('/mcp', { method: 'POST', body: '{}' })).ok, true, 'a late save needs no transient click activation');
  assert.equal(sent, 306);
  next.dispose();
});

test('round two: Resume grants fresh reads once per browser hour and cannot loop into a flood', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), saved = storage(); let sent = 0;
  const transport = async () => { sent++; return new Response('{}'); };
  let safety = createPollSafety({ ...c, storage: saved });
  const background = () => safety.fetch(transport, '/read', {}, { manual: false });
  for (let minute = 0; minute < 5; minute++) {
    for (let i = 0; i < 60; i++) await background();
    await c.advance(60_000);
  }
  await assert.rejects(background());
  await safety.resume();
  await background();
  assert.equal(sent, 301, 'Resume must actually admit a new request in a spent hour');
  for (let i = 0; i < 29; i++) await background();
  await assert.rejects(background());
  for (let i = 0; i < 100; i++) { await safety.resume(); await background().catch(() => {}); }
  assert.equal(sent, 330);
  safety.dispose();
  safety = createPollSafety({ ...c, storage: saved });
  await safety.resume(); await background().catch(() => {});
  assert.equal(sent, 330, 'navigation cannot reset the recovery allowance');
  assert.equal(safety.state().resumeAt, 3_900_000);
  safety.dispose();
});

for (const [page, logicalReads] of [['single-read pages', 1], ['Ideas and Sessions', 2], ['Model Room', 4], ['Control Room', 8], ['Calendar with twenty deals', 21]]) {
  test(`round two: ${page} plus shared panels stays unpaused all day with budget margin`, async () => {
    const { pollSafety } = await import('../js/poll-safety.mjs');
    const { createSessionBoundary } = await import('../js/private-session.js');
    const c = fakeClock(), safety = pollSafety(c.window, c), sent = [];
    const client = createSessionBoundary({ safety, invalidate() {}, fetchImpl: async path => {
      sent.push(c.now());
      return Response.json(path === '/auth/session' ? { actor: { slug: 'synthetic' }, csrf_token: 'synthetic-fixture' } : {});
    } });
    const pagePoll = mountAutoRefresh({ ...c, idleMs: Infinity, intervalMs: 15_000,
      refresh: () => Promise.all(Array.from({ length: logicalReads }, () => client.fetch('/mcp'))) });
    const panel = mountAutoRefresh({ ...c, idleMs: Infinity, intervalMs: 30_000,
      refresh: () => Promise.all(Array.from({ length: 3 }, () => client.fetch('/panel'))) });
    const identity = mountAutoRefresh({ ...c, idleMs: Infinity, intervalMs: 60_000, refresh: () => client.verify() });
    await c.advance(24 * 3_600_000);
    assert.ok(sent.length > 1_000, 'the page keeps updating throughout the day');
    assert.ok(sent.length <= 4_380, '180/hour pacing plus a bounded final batch');
    for (const time of sent) assert.ok(sent.filter(at => at > time - 3_600_000 && at <= time).length <= (logicalReads === 21 ? 270 : 240), 'every rolling hour retains at least 30 requests of margin');
    assert.equal(safety.state().paused, false);
    pagePoll.dispose(); panel.dispose(); identity.dispose(); safety.dispose();
  });
}

test('round two: twenty tabs share spent counters, recovery and human admission through ownership changes', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), shared = storage(), locks = lockManager(); let background = 0, human = 0;
  const tabs = Array.from({ length: 20 }, () => {
    const document = new EventTarget(); document.visibilityState = 'visible';
    const window = new EventTarget(); window.navigator = { locks }; window.localStorage = shared; window.sessionStorage = storage();
    window.setTimeout = c.window.setTimeout; window.clearTimeout = c.window.clearTimeout;
    return { window, document, safety: createPollSafety({ window, document, now: c.now }) };
  });
  const send = tab => tab.safety.fetch(async () => { background++; return new Response('{}'); }, '/read', {}, { manual: false });
  for (const tab of tabs) {
    for (let i = 0; i < 15; i++) await send(tab);
    tab.document.visibilityState = 'hidden'; tab.document.dispatchEvent(new Event('visibilitychange'));
    await c.advance(15_000);
  }
  assert.equal(background, 300);
  for (const tab of tabs) {
    tab.document.visibilityState = 'visible';
    await send(tab).catch(() => {});
    tab.document.visibilityState = 'hidden'; tab.document.dispatchEvent(new Event('visibilitychange'));
  }
  assert.equal(background, 300, 'twenty tab budgets cannot multiply the browser ceiling');
  await Promise.all(tabs.map(tab => tab.safety.resume()));
  tabs[0].document.visibilityState = 'visible';
  for (let i = 0; i < 31; i++) await send(tabs[0]).catch(() => {});
  assert.equal(background, 330, 'simultaneous Resume clicks share one recovery allowance');
  await Promise.all(tabs.flatMap(tab => Array.from({ length: 10 }, () => tab.safety.fetch(async () => { human++; return new Response('{}'); }, '/human', {}, { manual: true }).catch(() => {}))));
  assert.equal(human, 120, 'concurrent human requests reserve against one browser minute');
  tabs.forEach(tab => tab.safety.dispose());
});

test('round two: a real live-client save reserves its preflight as human during an exhausted background read', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const { createSessionBoundary } = await import('../js/private-session.js');
  const { createLiveClient } = await import('../js/live-client.js');
  const c = fakeClock(), safety = createPollSafety(c); let release, writes = 0, admitted;
  const ready = new Promise(resolve => { admitted = resolve; });
  const boundary = createSessionBoundary({ safety, invalidate() {}, fetchImpl: async path => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'synthetic' }, csrf_token: 'synthetic-fixture' });
    writes++; return Response.json({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
  } });
  const held = safety.run(async () => {
    for (let i = 0; i < 91; i++) await safety.fetch(async () => new Response('{}'), '/read').catch(() => {});
    await new Promise(resolve => { release = resolve; admitted(); });
  });
  await ready;
  const client = createLiveClient({ fetchImpl: boundary.fetch });
  try {
    const saved = await client.setNextStep({ deal: 'synthetic', next_step: 'Synthetic step' });
    assert.equal(saved.ok, true); assert.equal(writes, 1);
  } finally { release(); await held; safety.dispose(); }
});

test('round two: a follower cannot postpone the owner by attempting a cycle', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), shared = storage(), locks = lockManager(); let sent = 0;
  const tabs = Array.from({ length: 2 }, () => {
    const window = new EventTarget(), document = new EventTarget(); document.visibilityState = 'visible';
    window.navigator = { locks }; window.localStorage = shared;
    return createPollSafety({ window, document, now: c.now });
  });
  const read = safety => safety.run(() => safety.fetch(async () => { sent++; return new Response('{}'); }, '/read'));
  await read(tabs[0]);
  await c.advance(25_000);
  await read(tabs[1]);
  await c.advance(1_000);
  await read(tabs[0]);
  assert.equal(sent, 2, 'the owner keeps its eligible turn when a follower loses the lock');
  tabs.forEach(tab => tab.dispose());
});

test('round two: Resume deadline includes the recovery requests that settled after the click', async () => {
  const { createPollSafety } = await import('../js/poll-safety.mjs');
  const c = fakeClock(), safety = createPollSafety({ ...c, storage: storage() }); let sent = 0;
  const background = () => safety.fetch(async () => { sent++; return new Response('{}'); }, '/read', {}, { manual: false });
  for (let i = 0; i < 90; i++) await background();
  await assert.rejects(background());
  await safety.resume();
  await c.advance(30_000);
  for (let i = 0; i < 30; i++) await background();
  await assert.rejects(background());
  assert.equal(safety.state().resumeAt, 3_630_000, 'the displayed deadline includes the full recovery quota window');
  await c.advance(3_570_000);
  await safety.resume();
  assert.equal(safety.state().paused, true, 'the button deadline and admission predicate agree');
  await c.advance(30_000);
  await safety.resume();
  await background();
  assert.equal(sent, 121, 'the displayed deadline grants a usable fresh allowance');
  safety.dispose();
});
