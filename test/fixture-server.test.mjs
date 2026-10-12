import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from '../scripts/fixture-server.mjs';

const within = (promise, ms) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(Error(`unsettled after ${ms} ms`)), ms).unref())]);

test('a server that exits during startup rejects promptly instead of hanging cleanup', async () => {
  await assert.rejects(within(startFixtureServer({ args: ['-e', 'process.exit(1)'] }), 5000), /fixture server exited 1/);
});

test('a server that never announces its URL times out and is reaped', async () => {
  await assert.rejects(within(startFixtureServer({ args: ['-e', 'setInterval(() => {}, 1000)'], startupMs: 200 }), 5000),
    /startup timeout/);
});

test('stop is bounded when the server ignores SIGTERM', async () => {
  const server = await within(startFixtureServer({ stopMs: 300, args: ['-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('http://127.0.0.1:1')"] }), 5000);
  assert.equal(server.url, 'http://127.0.0.1:1');
  await within(server.stop(), 5000);
  await within(server.stop(), 5000);
});

test('the real fixture server serves and stops', async () => {
  const server = await within(startFixtureServer(), 15000);
  assert.equal((await fetch(server.url + '/')).status, 200);
  await within(server.stop(), 10000);
});
