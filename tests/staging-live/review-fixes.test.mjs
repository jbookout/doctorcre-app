import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production exploration goal stays within the pinned limit with the largest recovery entry', async () => {
  const { buildExplorationGoal } = await import('../../scripts/e2e-staging/explore.mjs');
  const { screens } = await import('../../scripts/e2e-staging/screens.mjs');
  const recovery = [
    {
      record: 'deal',
      id: '40000000-0000-4000-8000-000000000001',
      name: 'Synthetic staging deal',
      reason: 'closed',
      coverage_limited: true,
      guidance: 'Use the normal UI to reopen the invented deal if available, or create another invented deal for active controls.',
      current_name: 'x'.repeat(500),
    },
    { record: 'lead', id: '40000000-0000-4000-8000-000000000002', name: 'Synthetic staging lead', reason: 'archived' },
  ];
  const largestRecoveryEntry = recovery.toSorted((left, right) => JSON.stringify(right).length - JSON.stringify(left).length)[0];
  const records = Object.fromEntries(['party', 'client', 'deal', 'invoice', 'lead_party', 'lead', 'conversation', 'tour'].map((record, index) => [record, {
    id: `40000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    name: `${record}-${'x'.repeat(500)}`,
  }]));
  const needs_restore = Array.from({ length: 9 }, (_, index) => ({
    ...largestRecoveryEntry,
    id: `40000000-0000-4000-8000-${String(index + 30).padStart(12, '0')}`,
    current_name: `changed-${'x'.repeat(500)}`,
    guidance: `Use the normal UI for this bounded recovery case. ${'g'.repeat(500)}`,
  }));
  const setup = { records, needs_restore };
  assert.ok(JSON.stringify(setup).length >= 8_000, 'fixture must represent the full production setup payload');
  for (const screen of await screens()) {
    const goal = buildExplorationGoal({
      screen,
      setup,
    });
    assert.ok(goal.length <= 2_000, `${screen.path} production goal was ${goal.length} characters`);
    assert.doesNotMatch(goal, /x{100}/, 'raw setup records must not be serialized into the model goal');
  }
});

test('exploration attempt returns the original configuration error', async () => {
  const { runExplorationAttempt } = await import('../../scripts/e2e-staging/explore.mjs');
  const failure = new Error('the goal must be at most 2000 characters');
  const attempt = await runExplorationAttempt(async () => { throw failure; }, {});
  assert.equal(attempt.error, failure);
});

test('operator documentation states the finite exploration batch budget', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  assert.match(readme, /50-goal batches/);
  assert.match(readme, /81 planned model calls per goal/);
  assert.match(readme, /4,050 calls per full batch/);
  assert.match(readme, /5,000-call hard ceiling/);
  assert.doesNotMatch(readme, /caps a run at 20 model calls/);
});

test('control evidence ignores focus, generic requests and non-semantic DOM churn', async () => {
  const { classifyControlObservation } = await import('../../scripts/e2e-staging/controls.mjs');
  assert.deepEqual(classifyControlObservation({
    beforeURL: 'https://staging.example/work',
    directSignals: ['network request'],
    observed: { url: 'https://staging.example/work', mutations: 4, focus: 2, aria: 1, directMutations: 1, semanticChanged: false, valueChanged: false },
  }), { status: 'DEAD', reason: undefined, signals: [] });
  assert.deepEqual(classifyControlObservation({
    beforeURL: 'https://staging.example/work',
    directSignals: [],
    observed: { url: 'https://staging.example/work', mutations: 1, focus: 0, aria: 0, directMutations: 1, semanticChanged: true, valueChanged: false },
  }), { status: 'OBSERVED', reason: undefined, signals: ['main semantic change'] });
});

test('every staging record operation is pinned by the CARR interface contract', async () => {
  const contract = (await import('../../contracts/carr-interface.v1.json', { with: { type: 'json' } })).default;
  for (const operation of ['add-party', 'new-client', 'new-lead', 'read-deal-reconciliation']) {
    assert.ok(contract.mcp_operations.includes(operation), `${operation} is absent from the pinned CARR interface`);
  }
});

test('production config routes agents through the Model Room adapter', async () => {
  const source = await readFile(new URL('../../e2e.config.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /e2e\/oauth\/chatgpt|\bchatgpt\s*\(/);
  assert.match(source, /modelRoomExplorationModel/);

  const { loadConfigModule } = await import('../../node_modules/e2e/dist/config/load.js');
  const configPath = new URL('../../e2e.config.ts', import.meta.url).pathname;
  const previousTarget = process.env.E2E_TARGET;
  process.env.E2E_TARGET = 'staging-live';
  try {
    const first = await loadConfigModule(configPath);
    const second = await loadConfigModule(configPath);
    assert.equal(first.agents.default.model, second.agents.default.model, 'fresh config loads must share the aggregate budget');
    assert.equal(first.agents['bug-hunter'].model, first.agents.default.model);
  } finally {
    if (previousTarget === undefined) delete process.env.E2E_TARGET;
    else process.env.E2E_TARGET = previousTarget;
  }
});

test('Model Room model uses a named desk and enforces one aggregate call ceiling', async () => {
  const {
    EXPLORATION_MODEL_CALL_POLICY,
    MODEL_ROOM_DISPATCH_CONTRACT,
    createExplorationBatchPlan,
    createExplorationCallPlan,
    createModelCallBudget,
    createModelRoomModel,
    formatExplorationCallPlan,
  } = await import('../../scripts/e2e-staging/model-room.mjs');
  const calls = [];
  const dispatch = async request => {
    calls.push(request);
    return {
      msg_id: '40000000-0000-4000-8000-000000000001',
      desk: request.desk,
      kind: 'codex-session',
      task: request.task,
      dispatched_at: '2026-10-08T12:00:00+00:00',
      thread_id: 'synthetic-thread',
      resumed: false,
      status: 'completed',
      result: JSON.stringify({ content: [{ type: 'text', text: '{}' }] }),
    };
  };
  const model = createModelRoomModel({ desk: 'doctorcre-e2e', budget: createModelCallBudget(2), dispatch });
  const options = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'inspect the synthetic screen' }] }] };
  await model.doGenerate(options);
  await model.doGenerate(options);
  await assert.rejects(() => model.doGenerate(options), /aggregate model-call limit of 2/);
  assert.equal(model.provider, 'carr-model-room');
  assert.equal(model.modelId, 'doctorcre-e2e');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.desk === 'doctorcre-e2e' && call.fresh === true));

  const toolModel = createModelRoomModel({
    desk: 'doctorcre-e2e',
    budget: createModelCallBudget(1),
    dispatch: async request => ({ ...await dispatch(request), result: JSON.stringify({ content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'click', input: { target: 7 } }] }) }),
  });
  const toolResult = await toolModel.doGenerate(options);
  assert.deepEqual(toolResult.content, [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'click', input: '{"target":7}' }]);
  assert.equal(toolResult.finishReason.unified, 'tool-calls');

  const plan = createExplorationCallPlan(50);
  assert.deepEqual(plan, { goalCount: 50, perGoal: 40, callsPerGoal: 81, scheduled: 4_050, limit: 4_050, hardGlobalCeiling: 5_000 });
  assert.match(formatExplorationCallPlan(plan), /81 planned calls per goal × 50 goals = 4050; finite run cap 4050; hard global ceiling 5000/);
  assert.deepEqual(EXPLORATION_MODEL_CALL_POLICY, { perGoal: 40, hardGlobalCeiling: 5_000 });
  assert.deepEqual(MODEL_ROOM_DISPATCH_CONTRACT, {
    revision: 'carr-model-room-dispatch@0b2c8ec8be07df142519e6638da9ec3329edcef2',
    repository: 'jbookout/carr-system',
    relativePath: 'tools/room-bridge/dispatch.py',
    sha256: '64e801f718242cf4bbd9a056a3b11e9d4faeea907c74ca0e18ca438fb2b2c61c',
    argv: ['send', '{desk}', '-', '--fresh'],
  });
  assert.throws(() => createExplorationCallPlan(62), /5022 model calls.*hard global ceiling/);
  assert.deepEqual(createExplorationBatchPlan(90), {
    goalCount: 90,
    callsPerGoal: 81,
    totalCalls: 7_290,
    batches: [
      { number: 1, start: 0, goalCount: 50, plannedCalls: 4_050 },
      { number: 2, start: 50, goalCount: 40, plannedCalls: 3_240 },
    ],
  });

  const unknownEnvelope = createModelRoomModel({
    desk: 'doctorcre-e2e',
    budget: createModelCallBudget(1),
    dispatch: async request => ({ ...await dispatch(request), envelope_revision: 'unknown-v2' }),
  });
  await assert.rejects(() => unknownEnvelope.doGenerate(options), /unknown Model Room dispatcher envelope/);
  const changedEnvelope = createModelRoomModel({
    desk: 'doctorcre-e2e',
    budget: createModelCallBudget(1),
    dispatch: async request => ({ ...await dispatch(request), resumed: 'not-a-boolean' }),
  });
  await assert.rejects(() => changedEnvelope.doGenerate(options), /unknown Model Room dispatcher envelope/);
});

test('exploration schedule resumes after the finite cap without replaying completed goals', async () => {
  const { createExplorationSchedule } = await import('../../scripts/e2e-staging/explore.mjs');
  const targets = [
    { name: 'desktop', surface: 'app' },
    { name: 'phone', surface: 'app' },
  ];
  const routedScreens = Array.from({ length: 30 }, (_, index) => ({ name: `Workspace ${index}`, path: `/workspace-${index}`, surface: 'app' }));
  const initial = createExplorationSchedule({ targets, routedScreens });
  assert.equal(initial.planned.length, 90);
  const completed = initial.planned.slice(0, 50).map(row => ({ ...row, status: 'finished', steps: 1 }));
  const interrupted = { ...initial.planned[50], status: 'ERROR', steps: 0 };
  const resumed = createExplorationSchedule({ targets, routedScreens, prior: [...completed, interrupted] });
  assert.equal(resumed.completed.length, 50);
  assert.equal(resumed.pending.length, 40);
  assert.equal(resumed.pending[0].sequence, 51);
  assert.ok(resumed.pending.every(row => row.sequence > 50), 'a resumed batch must not replay a finished goal');
  assert.ok(resumed.pending.some(row => row.target === interrupted.target && row.screen === interrupted.screen && row.agent === interrupted.agent));
});

test('staging auth consumers follow every contract value when the contract changes', async () => {
  const contract = structuredClone((await import('../../contracts/e2e-staging.v1.json', { with: { type: 'json' } })).default);
  contract.exchange.method = 'PUT';
  contract.origin = 'https://changed-staging.example';
  contract.exchange.path = '/changed/exchange';
  contract.exchange.authorization = 'Desk E2E_SESSION_SECRET';
  contract.session.path = '/changed/session';
  contract.session.cookie = '__Host-changed_cookie';
  contract.session.actor_slug = 'changed-actor';
  contract.session.e2e_principal = 'changed-principal';

  const { readStagingAuthContract } = await import('../../scripts/e2e-staging/auth-contract.mjs');
  const auth = readStagingAuthContract(contract);
  assert.deepEqual(auth.exchange.request('secret-value'), {
    method: 'PUT',
    headers: { authorization: 'Desk secret-value' },
    maxRedirects: 0,
  });
  assert.equal(auth.exchange.path, '/changed/exchange');
  assert.equal(auth.session.path, '/changed/session');
  assert.equal(auth.session.matches({ actor: { slug: 'changed-actor' }, e2e_principal: 'changed-principal' }), true);
  assert.equal(auth.session.hasSecureCookie([{ name: '__Host-changed_cookie', httpOnly: true, secure: true }]), true);

  const sessionSource = await readFile(new URL('../../scripts/e2e-staging/session.mjs', import.meta.url), 'utf8');
  const recordsSource = await readFile(new URL('../../scripts/e2e-staging/records.mjs', import.meta.url), 'utf8');
  const workerSource = await readFile(new URL('../../src/worker.js', import.meta.url), 'utf8');
  for (const literal of ['/auth/e2e-session', '/auth/session', '__Host-dealroom_session', 'e2e-joe']) {
    assert.equal(sessionSource.includes(literal), false, `session consumer repeated ${literal}`);
    assert.equal(recordsSource.includes(literal), false, `records consumer repeated ${literal}`);
    assert.equal(workerSource.includes(literal), false, `Worker consumer repeated ${literal}`);
  }

  let carrCalls = 0;
  const { createDoctorcreRequestHandler } = await import('../../src/worker.js');
  const handle = createDoctorcreRequestHandler(contract);
  const response = await handle(new Request('https://app.doctorcre.com/changed/exchange', { method: 'PUT' }), {
    APP_ENV: 'production',
    CARR: { fetch: async () => { carrCalls += 1; return new Response('proxied'); } },
  });
  assert.equal(response.status, 404);
  assert.equal(carrCalls, 0, 'a changed E2E exchange path must never fall through the generic auth proxy');
  const stagingResponse = await handle(new Request('https://changed-staging.example/changed/exchange', { method: 'PUT' }), {
    APP_ENV: 'staging',
    CARR: { fetch: async () => { carrCalls += 1; return new Response(null, { status: 204 }); } },
  });
  assert.equal(stagingResponse.status, 204);
  assert.equal(carrCalls, 1, 'the versioned contract origin owns staging route admission');
});
