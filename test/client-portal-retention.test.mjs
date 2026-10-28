import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCommandDock } from '../js/command-dock.js';
import { pendingCommand, performCommand } from '../js/command-feedback.mjs';

const source = readFileSync(new URL('../js/pipeline.js', import.meta.url), 'utf8');
const key = 'client-portal:demo';
const password = 'synthetic-portal-password';

function registration(send) {
  const dock = createCommandDock();
  const operations = new Map();
  const context = vm.createContext({
    operations, dock, commandState: {}, pendingCommand, performCommand,
    uuidv4: () => 'synthetic-portal-operation',
    FOLLOW_UP_SENDERS: { 'register-client-portal': send },
    state: { boardSync: { requestRefresh() {} } },
  });
  vm.runInContext(source.slice(source.indexOf('async function runFollowUp('), source.indexOf('async function runMove(')) +
    '\nglobalThis.run = runFollowUp;', context);
  return {
    dock, operations,
    send: args => context.run(key, { verb: 'register-client-portal', args, summary: 'Client portal' }),
    pending: () => pendingCommand(context.commandState, key),
  };
}

function assertPasswordAbsent(h) {
  for (const [name, entries] of [['dock', h.dock.entries], ['operations', h.operations]]) {
    const retained = JSON.stringify([...entries.values()]);
    assert.equal(retained.includes(password), false, `${name} must not retain the registration password`);
    assert.equal(retained.includes('"password"'), false, `${name} must retain only password-free request data`);
  }
}

for (const refused of [false, true]) test(`a ${refused ? 'refused' : 'confirmed'} portal registration releases its password from dock and operations`, async () => {
  const h = registration(async request => {
    assert.equal(request.password, password, 'the producer receives the password');
    if (refused) {
      const error = new Error('Synthetic refusal');
      error.payload = { error: 'portal_slug_taken' };
      throw error;
    }
    return { ok: true };
  });
  const result = await h.send({ deal: 'demo', slug: 'demo-practice', password });
  assert.equal(result.status, refused ? 'refused' : 'ok');
  assert.equal(h.pending(), null, 'a settled registration releases the retained command');
  assertPasswordAbsent(h);
});

test('an unanswered registration retains its password only for exact replay, then releases it', async () => {
  const requests = [];
  const h = registration(async request => {
    requests.push(request);
    if (requests.length === 1) throw new Error('Synthetic lost response');
    return { ok: true };
  });
  assert.equal((await h.send({ deal: 'demo', slug: 'demo-practice', password })).status, 'unknown');
  assert.equal(h.pending().request.password, password);
  assertPasswordAbsent(h);
  assert.equal((await h.send(h.pending().request)).status, 'ok');
  assert.equal(requests[1], requests[0], 'Check outcome sends the same frozen request and safety key');
  assert.equal(h.pending(), null);
  assertPasswordAbsent(h);
});
