import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { assuranceHealthRequest, ASSURANCE_CONTRACT, assuranceHealthState, evidenceAge, loadAssuranceHealth } from '../js/assurance-health-model.js';
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
  for (const state of ['unknown', 'degraded', 'healthy', 'failed', 'disabled', 'not-yet-operational']) {
    const model = assuranceHealthState(projection(state), scope, NOW);
    assert.equal(model.state, state);
    assert.equal(model.green, state === 'healthy');
    assert.deepEqual(model.scope, scope);
    assert.equal(model.evidence.length, 6);
    for (const row of model.evidence) assert.equal(row.age, row.state === 'missing' ? 'age unknown' : '5m old');
    assert.equal(model.evidence.at(-1).state, state === 'degraded' ? 'failed' : state === 'not-yet-operational' ? 'missing' : 'passing');
  }
});

test('workflow truth prerequisites apply to all six display states', async t => {
  for (const state of ['healthy', 'degraded', 'failed', 'unknown', 'disabled', 'not-yet-operational']) {
    for (const truthState of ['unknown', 'conflict', 'undeclared', 'declared_disabled', 'unregistered', 'enabled_shadow_only', 'enabled_canary_eligible', 'enabled_live_eligible', 'operational']) {
      await t.test(`${state} / ${truthState}`, () => {
        const answer = projection(state);
        answer.workflow_truth = { available: true, source: 'V5-F09 workflow census', state: truthState,
          enabled: truthState !== 'declared_disabled', admissible_modes: ['shadow', 'canary', 'live'] };
        // Literal expected prerequisites from the pinned producer's truth-first branches.
        const refused = ['unknown', 'conflict', 'undeclared'].includes(truthState) ? state !== 'unknown'
          : truthState === 'declared_disabled' ? state !== 'disabled' : state === 'disabled';
        const model = assuranceHealthState(answer, scope, NOW);
        assert.equal(model.state, refused ? 'unknown' : state);
        if (refused) { assert.equal(model.green, false); assert.match(model.reason, /invalid/); }
        else assert.doesNotMatch(model.reason, /invalid/);
      });
    }
  }
});

test('affirmative claims refuse contradictions in evidence summaries, impact, recovery and stages', async t => {
  const variants = {
    failing_layers: a => { a.failing_layers = ['artifact_assessment']; },
    indeterminate_layers: a => { a.indeterminate_layers = ['controller_assessment']; },
    missing_layers: a => { a.missing_layers = ['activation_readback']; },
    unbindable_layers: a => { a.unbindable_layers = ['actual_business_outcome']; },
    withdrawn_act: a => { a.impact.withdrawn_stages = ['act']; },
    withdrawn_draft: a => { a.impact.withdrawn_stages = ['draft']; },
    withdrawn_read: a => { a.impact.withdrawn_stages = ['read']; },
    recovery_required: a => { a.recovery.required_evidence = ['artifact_assessment']; },
    attributable_unavailable: a => { a.capability_stage_attributable_to_findings = 'unavailable'; },
    attributable_read: a => { a.capability_stage_attributable_to_findings = 'read'; },
    attributable_draft: a => { a.capability_stage_attributable_to_findings = 'draft'; },
  };
  for (const [name, mutate] of Object.entries(variants)) await t.test(name, () => {
    const answer = projection('healthy'); mutate(answer);
    const model = assuranceHealthState(answer, scope, NOW);
    assert.equal(model.state, 'unknown'); assert.equal(model.green, false); assert.match(model.reason, /invalid/);
  });
});

test('observation, expiry and both readbacks require explicit offsets and valid calendar/time components', async t => {
  const invalid = ['2026-10-01T14:55:00', '2026-10-01T14:55:00.000', '2026-02-30T14:55:00Z',
    '2026-02-29T14:55:00Z', '2026-04-31T14:55:00+00:00', '2026-10-01T24:00:00Z',
    '2026-10-01T14:60:00Z', '2026-10-01T14:55:60Z', '2026-13-01T14:55:00Z',
    '2026-10-00T14:55:00Z', '2026-10-01T14:55:00+24:00', '2026-10-01T14:55:00+00:60'];
  for (const [layer, field] of [['artifact_assessment', 'observed_at'], ['artifact_assessment', 'expires_at'],
    ['controller_assessment', 'readback_at'], ['activation_readback', 'readback_at']]) {
    for (const value of invalid) await t.test(`${layer}.${field} / ${value}`, () => {
      const answer = projection('healthy'); answer.evidence[layer][field] = value;
      const model = assuranceHealthState(answer, scope, NOW);
      assert.equal(model.state, 'unknown'); assert.equal(model.green, false); assert.match(model.reason, /invalid/);
    });
  }
  for (const value of invalid) assert.equal(evidenceAge(value, NOW), 'age unknown');
});

test('explicit-offset evidence has device-independent freshness; local-time evidence is refused in every timezone', () => {
  const script = `
    import { assuranceHealthState } from './js/assurance-health-model.js';
    import { projection, scope, NOW } from './test/fixtures/assurance-health.mjs';
    const local = projection('healthy');
    local.evidence.artifact_assessment.observed_at = '2026-10-01T14:55:00';
    local.evidence.artifact_assessment.expires_at = '2026-10-01T15:10:00';
    const offset = projection('healthy');
    for (const row of Object.values(offset.evidence)) {
      row.observed_at = '2026-10-01T09:55:00-05:00'; row.expires_at = '2026-10-01T20:40:00+05:30';
      if ('readback_at' in row) row.readback_at = '2026-10-01T20:25:00+05:30';
    }
    console.log(JSON.stringify([assuranceHealthState(local, scope, NOW), assuranceHealthState(offset, scope, NOW)]));
  `;
  for (const TZ of ['UTC', 'America/Chicago', 'Pacific/Kiritimati']) {
    const [local, offset] = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, TZ }, encoding: 'utf8',
    }));
    assert.equal(local.state, 'unknown', TZ); assert.equal(local.green, false, TZ); assert.match(local.reason, /invalid/, TZ);
    assert.equal(offset.state, 'healthy', TZ); assert.equal(offset.green, true, TZ);
    assert.ok(offset.evidence.every(row => row.age === '5m old' && row.fresh), TZ);
  }
  const leap = projection('healthy');
  leap.evidence.controller_assessment.readback_at = '2024-02-29T23:59:59.123456+00:00';
  assert.equal(assuranceHealthState(leap, scope, NOW).state, 'healthy');
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
