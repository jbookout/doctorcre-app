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
  for (const screen of await screens()) {
    const goal = buildExplorationGoal({
      screen,
      setup: { records: { deal: { id: largestRecoveryEntry.id, name: largestRecoveryEntry.name } }, needs_restore: [largestRecoveryEntry] },
    });
    assert.ok(goal.length <= 2_000, `${screen.path} production goal was ${goal.length} characters`);
  }
});

test('exploration attempt returns the original configuration error', async () => {
  const { runExplorationAttempt } = await import('../../scripts/e2e-staging/explore.mjs');
  const failure = new Error('the goal must be at most 2000 characters');
  const attempt = await runExplorationAttempt(async () => { throw failure; }, {});
  assert.equal(attempt.error, failure);
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
  const { EXPLORATION_MODEL_CALL_LIMIT, createModelCallBudget, createModelRoomModel, explorationModelCallBudget } = await import('../../scripts/e2e-staging/model-room.mjs');
  const calls = [];
  const dispatch = async request => {
    calls.push(request);
    return { status: 'completed', result: JSON.stringify({ content: [{ type: 'text', text: '{}' }] }) };
  };
  const model = createModelRoomModel({ desk: 'doctorcre-e2e', budget: createModelCallBudget(2), dispatch });
  const options = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'inspect the synthetic screen' }] }] };
  await model.doGenerate(options);
  await model.doGenerate(options);
  await assert.rejects(() => model.doGenerate(options), /aggregate model-call limit of 2/);
  assert.equal(model.provider, 'carr-model-room');
  assert.equal(model.modelId, 'doctorcre-e2e');
  assert.equal(EXPLORATION_MODEL_CALL_LIMIT, 20);
  assert.deepEqual(explorationModelCallBudget.snapshot(), { used: 0, limit: 20, remaining: 20 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.desk === 'doctorcre-e2e' && call.fresh === true));

  const toolModel = createModelRoomModel({
    desk: 'doctorcre-e2e',
    budget: createModelCallBudget(1),
    dispatch: async () => ({ status: 'completed', result: JSON.stringify({ content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'click', input: { target: 7 } }] }) }),
  });
  const toolResult = await toolModel.doGenerate(options);
  assert.deepEqual(toolResult.content, [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'click', input: '{"target":7}' }]);
  assert.equal(toolResult.finishReason.unified, 'tool-calls');
});

test('staging auth consumers follow every contract value when the contract changes', async () => {
  const contract = structuredClone((await import('../../contracts/e2e-staging.v1.json', { with: { type: 'json' } })).default);
  contract.exchange.method = 'PUT';
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
  for (const literal of ['/auth/e2e-session', '/auth/session', '__Host-dealroom_session', 'e2e-joe']) {
    assert.equal(sessionSource.includes(literal), false, `session consumer repeated ${literal}`);
    assert.equal(recordsSource.includes(literal), false, `records consumer repeated ${literal}`);
  }
});
