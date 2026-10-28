import test from 'node:test';
import assert from 'node:assert/strict';
import { createPollSafety } from '../js/poll-safety.mjs';
import { createSessionBoundary } from '../js/private-session.js';

function fixture() {
  let time = 0;
  const values = new Map(), sent = [];
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const safety = createPollSafety({ storage, now: () => time });
  const fetchImpl = async () => { sent.push(time); return new Response('{}'); };
  return { safety, storage, sent, fetchImpl, at(value) { time = value; },
    background: () => safety.fetch(fetchImpl, '/read', {}, { manual: false }) };
}

test('session legs sent across a minute boundary count at their physical send times', async () => {
  const f = fixture(), transport = f.safety.transport(f.fetchImpl, 3, { manual: false });
  f.at(59_990); await transport('/auth/session');
  f.at(60_010); await transport('/mcp');
  f.at(60_020); await transport('/auth/session');
  f.at(120_000);
  for (let i = 0; i < 88; i++) await f.background();
  await assert.rejects(f.background());
  assert.equal(f.sent.filter(time => time > 60_000 && time <= 120_000).length, 90);
  await transport.release?.(); f.safety.dispose();
});

test('session legs cannot carry hidden physical requests into the next rolling hour', async () => {
  const f = fixture(); f.at(3_599_990);
  const transport = f.safety.transport(f.fetchImpl, 3, { manual: false });
  await transport('/auth/session');
  f.at(3_600_010); await transport('/mcp');
  f.at(3_600_020); await transport('/auth/session');
  f.at(3_600_030); for (let i = 0; i < 87; i++) await f.background();
  f.at(3_660_030); for (let i = 0; i < 90; i++) await f.background();
  f.at(3_720_030); for (let i = 0; i < 90; i++) await f.background();
  f.at(3_780_030); for (let i = 0; i < 30; i++) await f.background();
  f.at(7_200_000); await f.background();
  await assert.rejects(f.background());
  assert.equal(f.sent.filter(time => time > 3_600_000 && time <= 7_200_000).length, 300);
  await transport.release?.(); f.safety.dispose();
});

test('another tab cannot steal the session checks reserved before a human write', async () => {
  const f = fixture();
  for (let i = 0; i < 297; i++) await f.safety.fetch(f.fetchImpl, '/human', {}, { manual: true });
  const transport = f.safety.transport(f.fetchImpl, 3, { manual: true });
  await transport('/auth/session');
  const other = createPollSafety({ storage: f.storage, now: () => 0 });
  await assert.rejects(other.fetch(f.fetchImpl, '/other', {}, { manual: true }));
  await transport('/write'); await transport('/auth/session');
  assert.equal(f.sent.length, 300);
  await transport.release?.(); other.dispose(); f.safety.dispose();
});

test('abandoned session reservations expire and late legs cannot make uncounted requests', async () => {
  const f = fixture(), transport = f.safety.transport(f.fetchImpl, 3, { manual: false });
  await transport('/auth/session');
  f.at(60_001);
  await assert.rejects(transport('/mcp'));
  assert.equal(f.sent.length, 1);
  for (let i = 0; i < 90; i++) await f.background();
  assert.equal(f.sent.length, 91, 'expired unused capacity is available to new reads');
  await transport.release?.(); f.safety.dispose();
});

test('a failed session releases its unused write capacity immediately', async () => {
  const f = fixture();
  for (let i = 0; i < 297; i++) await f.safety.fetch(f.fetchImpl, '/human', {}, { manual: true });
  const client = createSessionBoundary({ safety: f.safety, invalidate() {}, fetchImpl: async () => { throw Error('offline'); } });
  await assert.rejects(client.fetch('/write', { method: 'POST' }));
  await f.safety.fetch(f.fetchImpl, '/human', {}, { manual: true });
  await f.safety.fetch(f.fetchImpl, '/human', {}, { manual: true });
  assert.equal(f.sent.length, 299);
  f.safety.dispose();
});

test('delayed session legs and repeated Resume keep physical sends below 7920 in a half-open browser day', async () => {
  const f = fixture(), day = 86_400_000;
  f.at(day - 10);
  const transport = f.safety.transport(f.fetchImpl, 3, { manual: false });
  await transport('/auth/session');
  f.at(day + 10); await transport('/mcp');
  f.at(day + 20); await transport('/auth/session');
  await transport.release();
  for (let minute = 0; minute < 1440; minute++) {
    f.at(day + 30 + minute * 60_000);
    await f.safety.resume();
    for (let request = 0; request < 90; request++) await f.background().catch(() => {});
  }
  const inside = f.sent.filter(time => time >= day && time < day * 2);
  assert.ok(inside.length > 300, 'fresh recovery allowance continues to admit updates');
  assert.ok(inside.length <= 7920);
  for (const end of inside) assert.ok(f.sent.filter(time => time > end - 3_600_000 && time <= end).length <= 330);
  f.safety.dispose();
});

test('a lock completion crossing the minute boundary cannot misdate the physical send', async () => {
  let time = 59_999, crossBoundary = true;
  const values = new Map(), sent = [];
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const locks = { async request(name, _options, callback) {
    const result = callback({});
    if (name === 'doctorcre-poll-budget-v2' && crossBoundary) { time = 60_001; crossBoundary = false; }
    return result;
  } };
  const safety = createPollSafety({ storage, locks, now: () => time });
  const fetchImpl = async () => { sent.push(time); return new Response('{}'); };
  await safety.fetch(fetchImpl, '/read', {}, { manual: false });
  time = 120_000;
  for (let i = 0; i < 90; i++) await safety.fetch(fetchImpl, '/read', {}, { manual: false });
  assert.equal(sent.filter(at => at > 60_000 && at <= 120_000).length, 90);
  safety.dispose();
});
