import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assuranceHealthRequest, ASSURANCE_CONTRACT, assuranceHealthState, loadAssuranceHealth } from '../js/assurance-health-model.js';
import { createLiveClient } from '../js/live-client.js';

const inputSchema = { type: 'object', additionalProperties: false, properties: { scope: {
  type: 'object', additionalProperties: false, properties: {
    workflow_key: { type: 'string', minLength: 1, maxLength: 255 },
    workflow_version: { type: 'integer', minimum: 1 },
    work_request_id: { type: 'string', pattern: '^WR-[0-9]{1,12}$' },
  }, required: ['workflow_key', 'workflow_version'],
} }, required: ['scope'] };
import { scope, NOW, projection, missingProjection } from './fixtures/assurance-health.mjs';

test('read-assurance-health pins the exact producer request and response contract', async () => {
  const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1.json', import.meta.url), 'utf8'));
  const read = contract.mcp_read_contracts['read-assurance-health'];
  assert.equal(read.write, false);
  assert.deepEqual(read.inputSchema, inputSchema);
  assert.deepEqual(read.response, ASSURANCE_CONTRACT);
  assert.match(read.producer.source_commit, /^[a-f0-9]{40}$/);
  assert.equal(read.producer.module, 'mcp-server/src/assurance-health-store.v5.js');
  assert.ok(contract.mcp_operations.includes('read-assurance-health'));
  assert.ok(!contract.mcp_operations.includes('record-assurance-health-evidence'));
});

test('the live client sends only exact read keys, validates before fetching, and preserves scope', async () => {
  const calls = [];
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ result: { content: [{ text: '{}' }] } }));
  } });
  await client.readAssuranceHealth({ scope });
  assert.equal(calls[0].path, '/mcp');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].init.body).params, { name: 'read-assurance-health', arguments: { scope } });
  const bad = [null, {}, { scope, actor: 'demo' }, { scope: { ...scope, extra: true } },
    { scope: { ...scope, workflow_version: '3' } }, { scope: { ...scope, workflow_version: 0 } },
    { scope: { ...scope, workflow_key: '' } }, { scope: { ...scope, workflow_key: 'x'.repeat(256) } },
    { scope: { ...scope, work_request_id: null } }, { scope: { ...scope, work_request_id: 'demo' } }];
  for (const args of bad) { assert.throws(() => assuranceHealthRequest(args)); await assert.rejects(() => client.readAssuranceHealth(args)); }
  assert.equal(calls.length, 1);
  assert.deepEqual(assuranceHealthRequest({ scope: { workflow_key: 'demo.workflow', workflow_version: 3 } }),
    { scope: { workflow_key: 'demo.workflow', workflow_version: 3 } });
});

const clone = value => structuredClone(value);
test('every covered state is scoped and shows each server evidence age; uncovered states stay unknown', () => {
  for (const state of ['unknown', 'degraded', 'healthy']) {
    const model = assuranceHealthState(projection(state), scope, NOW);
    assert.equal(model.state, state);
    assert.equal(model.green, state === 'healthy');
    assert.deepEqual(model.scope, scope);
    assert.equal(model.evidence.length, 6);
    for (const row of model.evidence) assert.equal(row.age, '5m old');
    assert.equal(model.evidence.at(-1).state, state === 'degraded' ? 'failed' : 'passing');
  }
});

test('all response and nested payload keys are exact against the pinned served projection', () => {
  const paths = [[], ['scope'], ['owner'], ['workflow_truth'], ['impact'], ['impact', 'scope_limited_to'], ['recovery'], ['evidence'],
    ...Object.keys(projection().evidence).flatMap(layer => [['evidence', layer], ['evidence', layer, 'scope']])];
  for (const sample of [projection(), projection('degraded'), missingProjection()]) {
    for (const path of paths) {
      const row = path.reduce((value, key) => value[key], sample);
      for (const key of [...Object.keys(row), 'unexpected']) {
        const bad = clone(sample); const target = path.reduce((value, k) => value[k], bad);
        if (key === 'unexpected') target[key] = true; else delete target[key];
        const model = assuranceHealthState(bad, scope, NOW);
        assert.equal(model.state, 'unknown', `${path.join('.')}.${key}`);
        assert.equal(model.green, false);
        assert.match(model.reason, /invalid/);
      }
    }
  }
});

test('missing, stale, future, duplicate, and sibling-scope evidence cannot show green', () => {
  const variants = [answer => { answer.evidence.controller_assessment = missingProjection().evidence.controller_assessment; },
    answer => { answer.evidence.controller_assessment.expires_at = '2026-10-01T14:59:00.000Z'; },
    answer => { answer.evidence.controller_assessment.observed_at = '2026-10-01T15:01:00.000Z'; },
    answer => { answer.evidence.controller_assessment.evidence_digest = answer.evidence.activation_readback.evidence_digest; },
    answer => { answer.evidence.controller_assessment.scope.workflow_version = 4; },
    answer => { answer.workflow_truth.available = false; },
    answer => { answer.green = false; }];
  for (const mutate of variants) {
    const answer = projection('healthy'); mutate(answer);
    assert.equal(assuranceHealthState(answer, scope, NOW).state, 'unknown');
    assert.equal(assuranceHealthState(answer, scope, NOW).green, false);
  }
  const fresh = projection('healthy');
  assert.equal(assuranceHealthState(fresh, scope, NOW).state, 'healthy');
  const expired = assuranceHealthState(fresh, scope, NOW + 600001);
  assert.equal(expired.state, 'unknown'); assert.equal(expired.green, false);
  assert.match(expired.reason, /expired/);
  assert.equal(expired.evidence[0].age, '15m old');
});

test('absent evidence has unknown age and failed/refused reads never produce healthy or zero', () => {
  assert.ok(assuranceHealthState(missingProjection(), scope, NOW).evidence.every(row => row.age === 'age unknown'));
  for (const answer of [undefined, null, new Error('demo refusal'), { ok: false, error: 'refused' }]) {
    const model = assuranceHealthState(answer, scope, NOW);
    assert.equal(model.state, 'unknown'); assert.equal(model.green, false);
    assert.doesNotMatch(JSON.stringify(model), /healthy|"count":0/);
  }
});

test('failed, refused and timed-out assurance reads settle unknown independently', async () => {
  for (const read of [async () => { throw new Error('demo failure'); }, async () => ({ error: 'demo refusal' }), () => new Promise(() => {})]) {
    const answer = await loadAssuranceHealth({ readAssuranceHealth: read }, scope, { timeoutMs: 5 });
    assert.equal(assuranceHealthState(answer, scope, NOW).state, 'unknown');
  }
});

test('business-outcome passing evidence without a work request cannot be green', () => {
  const answer = projection('healthy');
  const workflowScope = { workflow_key: scope.workflow_key, workflow_version: scope.workflow_version };
  answer.scope = workflowScope; answer.impact.scope_limited_to = workflowScope;
  for (const row of Object.values(answer.evidence)) row.scope = workflowScope;
  assert.equal(assuranceHealthState(answer, workflowScope, NOW).state, 'unknown');
});

test('fixture adapter implements the same exact read contract with missing evidence and unknown ages', async () => {
  const { createFixtureClient } = await import('../js/fixture-client.js');
  const seed = await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8');
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString('base64')}` });
  const workflowScope = { workflow_key: 'demo.workflow', workflow_version: 3 };
  const answer = await client.readAssuranceHealth({ scope: workflowScope });
  const model = assuranceHealthState(answer, workflowScope, NOW);
  assert.equal(model.state, 'unknown'); assert.match(model.reason, /Demo fixture/);
  assert.equal(model.evidence.length, 6); assert.ok(model.evidence.every(row => row.age === 'age unknown'));
  assert.equal(model.evidence.at(-1).state, 'unbindable');
  await assert.rejects(() => client.readAssuranceHealth({ scope: workflowScope, actor: 'demo' }));
});
