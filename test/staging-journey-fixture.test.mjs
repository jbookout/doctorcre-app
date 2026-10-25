import test from 'node:test';
import assert from 'node:assert/strict';
import { requireStagingAuthority, withJourneyFixture, withHomeFixture } from '../tests/staging/journey-fixture.mjs';

test('Home uses the same run-owned cleanup after an assertion failure', async () => {
  const actions = [];
  await assert.rejects(withHomeFixture(() => { throw new Error('Home assertion'); }, async action => {
    actions.push(action);
    return action === 'prepare' ? {} : { remaining: 0 };
  }), /Home assertion/);
  assert.deepEqual(actions, ['prepare', 'cleanup']);
});

test('an unbound provider credential refuses before the producer can inspect local credentials', async () => {
  const beforeRepo = process.env.CARR_JOURNEY_FIXTURE_REPO;
  const beforeKey = process.env.NEON_API_KEY;
  try {
    process.env.CARR_JOURNEY_FIXTURE_REPO = '/nonexistent/synthetic-producer';
    delete process.env.NEON_API_KEY;
    await assert.rejects(withJourneyFixture(() => assert.fail('fixture must not run')),
      /NEON_API_KEY must be bound for the staging fixture producer/);
  } finally {
    if (beforeRepo === undefined) delete process.env.CARR_JOURNEY_FIXTURE_REPO;
    else process.env.CARR_JOURNEY_FIXTURE_REPO = beforeRepo;
    if (beforeKey === undefined) delete process.env.NEON_API_KEY;
    else process.env.NEON_API_KEY = beforeKey;
  }
});

test('authority outage fails explicitly before preparing a fixture', async () => {
  const request = { post: async () => ({ status: () => 200, json: async () => ({ result: { content: [{ type: 'text', text: '{"error":"authority_connection_unavailable"}' }] } }) }) };
  await assert.rejects(requireStagingAuthority(request), /staging authority unavailable/);
});

test('cleanup runs even when the browser assertion fails', async () => {
  const actions = [];
  const produce = async (action, run) => {
    actions.push(action);
    return action === 'prepare' ? { run } : { remaining: 0 };
  };
  await assert.rejects(withJourneyFixture(async () => { throw new Error('browser assertion'); }, produce), /browser assertion/);
  assert.deepEqual(actions, ['prepare', 'cleanup']);
});

test('nonempty cleanup fails the test', async () => {
  await assert.rejects(withJourneyFixture(async () => {}, async action => action === 'prepare' ? {} : { remaining: 1 }), /leftover fixture/);
});

test('authority probe conforms to the MCP schema and cannot issue a share', async () => {
  let payload;
  const request = { post: async (_path, options) => {
    payload = options.data.params.arguments;
    return { status: () => 200, json: async () => ({ result: { content: [{ type: 'text', text: '{"error":"tour_share_scope_invalid"}' }] } }) };
  } };
  await requireStagingAuthority(request);
  assert.match(payload.projection_id, /^[a-f0-9-]{36}$/);
  assert.equal(payload.permission_scopes.length, 1);
  assert.equal(payload.permission_scopes[0], 'invalid-preflight-scope');
});

test('cleanup also runs when fixture preparation loses its response', async () => {
  const actions = [];
  await assert.rejects(withJourneyFixture(async () => {}, async action => {
    actions.push(action);
    if (action === 'prepare') throw new Error('lost response');
    return { remaining: 0 };
  }), /lost response/);
  assert.deepEqual(actions, ['prepare', 'cleanup']);
});

test('cleanup recovers from a transient failure without replacing the browser error or run', async () => {
  const browserError = new Error('original browser assertion');
  const actions = [];
  let fixtureRun, owned = true, failed = false;
  const producer = async (action, run) => {
    fixtureRun ||= run;
    assert.equal(run, fixtureRun);
    actions.push(action);
    if (action === 'prepare') return { run };
    if (action === 'remaining') return { remaining: owned ? 1 : 0 };
    if (!failed) { failed = true; throw new Error('transient cleanup outage'); }
    owned = false;
    return { remaining: 0 };
  };
  await assert.rejects(withJourneyFixture(async () => { throw browserError; }, producer), error => {
    assert.equal(error, browserError);
    assert.equal(error.fixtureRun, fixtureRun);
    return true;
  });
  assert.equal(owned, false);
  assert.deepEqual(actions, ['prepare', 'cleanup', 'remaining', 'cleanup']);
});

test('lost cleanup response is reconciled without replaying a committed cleanup', async () => {
  const actions = [];
  let owned = true;
  const result = await withJourneyFixture(async () => 'browser complete', async action => {
    actions.push(action);
    if (action === 'prepare') return {};
    if (action === 'remaining') return { remaining: owned ? 1 : 0 };
    owned = false;
    throw new Error('cleanup committed but response was lost');
  });
  assert.equal(result, 'browser complete');
  assert.equal(owned, false);
  assert.deepEqual(actions, ['prepare', 'cleanup', 'remaining']);
});

test('failed state reads never permit a cleanup replay until ownership reads back', async () => {
  const actions = [];
  let reads = 0, writes = 0;
  await withJourneyFixture(async () => {}, async action => {
    actions.push(action);
    if (action === 'prepare') return {};
    if (action === 'remaining') {
      if (++reads === 1) throw new Error('state read unavailable');
      return { remaining: 1 };
    }
    if (++writes === 1) throw new Error('cleanup response lost');
    return { remaining: 0 };
  });
  assert.deepEqual(actions, ['prepare', 'cleanup', 'remaining', 'remaining', 'cleanup']);
});

test('exhausted recovery retains the original error and cause and reports the recoverable run', async () => {
  const cause = new Error('original browser cause');
  const browserError = new Error('original browser assertion', { cause });
  let fixtureRun;
  await assert.rejects(withJourneyFixture(async () => { throw browserError; }, async (action, run) => {
    fixtureRun = run;
    if (action === 'prepare') return {};
    throw new Error('persistent producer outage');
  }), error => {
    assert.equal(error, browserError);
    assert.equal(error.cause, cause);
    assert.equal(error.fixtureRun, fixtureRun);
    assert.equal(error.message.includes('original browser assertion'), true);
    assert.equal(error.message.includes(fixtureRun), true);
    return true;
  });
});
