import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAppRelease } from '../scripts/verify-app-release.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const identity = { service: 'doctorcre-app', source_commit: sha, environment: 'staging', provider_version_id: 'synthetic-version' };

test('release readback waits for the exact deployed source and environment', async () => {
  const replies = [new Error('not yet reachable'), { ...identity, source_commit: 'f'.repeat(40) }, identity];
  const pauses = [];
  const result = await verifyAppRelease('https://staging.example/app-release', sha, 'staging', {
    fetchRelease: async (url, options) => {
      assert.equal(url, 'https://staging.example/app-release');
      assert.equal(options.cache, 'no-store');
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return Response.json(reply);
    },
    pause: async milliseconds => pauses.push(milliseconds),
  });
  assert.deepEqual(result, { source_commit: sha, environment: 'staging', provider_version_id: 'synthetic-version' });
  assert.deepEqual(pauses, [5000, 5000]);
});

test('release readback refuses wrong source, wrong environment and malformed responses after the bounded reads', async () => {
  for (const reply of [{ ...identity, source_commit: 'f'.repeat(40) }, { ...identity, environment: 'production' }, {}]) {
    let reads = 0;
    await assert.rejects(verifyAppRelease('https://staging.example/app-release', sha, 'staging', {
      fetchRelease: async () => { reads++; return Response.json(reply); },
      pause: async () => {},
    }), /did not serve the expected staging source/);
    assert.equal(reads, 12);
  }
});
