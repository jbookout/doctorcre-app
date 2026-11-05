import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const bundle = await build({ entryPoints: ['src/ui/portal/tour-list-state.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { createTourList } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const properties = JSON.parse(readFileSync('test/fixtures/portal-tour-list.market-study.json')).properties;
const id = properties.find(p => p.role === 'candidate').id;
const snapshot = { version: 4, selected: [], notes: {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(overrides = {}) {
  const cleared = [], gates = [];
  const ports = { read: async () => snapshot, save: async request => ({ version: request.version + 1, selected: request.selected, notes: request.notes }), signOut: async () => {}, clearPrivateState: () => cleared.push(1), returnToGate: () => gates.push(1), ...overrides };
  return { model: createTourList(properties, ports, () => 'synthetic-key', 30), cleared, gates };
}
test('load, canonical edit, sanitized bounded note, save and confirmed reload', async () => {
  const { model } = setup(); await tick(); assert.equal(model.state.kind, 'ready');
  model.edit('row label', true); assert.equal(model.state.kind, 'ready');
  model.edit(id, true); model.note(id, 'a\0' + 'b'.repeat(2200));
  assert.equal(model.state.draft.notes[id].length, 2000); assert.equal(model.state.draft.notes[id].includes('\0'), false);
  await model.save(); assert.equal(model.state.kind, 'ready'); assert.equal(model.state.base.version, 5);
  model.edit(id, false); assert.equal(model.reload(), false); await model.reload(true); assert.equal(model.state.kind, 'ready'); model.dispose();
});
test('409 locks writes until explicit discard and reload', async () => {
  let count = 0;
  const { model } = setup({ save: async () => { count++; throw { status: 409 }; } }); await tick(); model.edit(id, true); await model.save();
  assert.equal(model.state.kind, 'conflict'); model.edit(id, false); await model.save(); assert.equal(count, 1); assert.equal(model.reload(), false);
  await model.reload(true); assert.equal(model.state.kind, 'ready'); model.dispose();
});
test('uncertain and partial receipts keep exact immutable request on retry', async () => {
  const requests = []; let fail = true;
  const { model } = setup({ save: async request => { requests.push(request); if (fail) throw Error(); return { version: 5, selected: request.selected, notes: request.notes }; } });
  await tick(); model.edit(id, true); await model.save(); assert.equal(model.state.kind, 'uncertain'); model.edit(id, false); fail = false; await model.save();
  assert.equal(requests[0], requests[1]); assert.ok(Object.isFrozen(requests[0].notes)); assert.equal(model.state.kind, 'ready'); model.dispose();
  const partial = setup({ save: async () => ({ ...snapshot, version: 5 }) }).model; await tick(); partial.edit(id, true); await partial.save(); assert.equal(partial.state.kind, 'uncertain'); partial.dispose();
});
test('load failure retries, invalid IDs refuse and 401 expires', async () => {
  let bad = true;
  const { model } = setup({ read: async () => { if (bad) throw Error(); return snapshot; } }); await tick(); assert.equal(model.state.kind, 'unavailable'); bad = false; await model.reload(); assert.equal(model.state.kind, 'ready'); model.dispose();
  const invalid = setup({ read: async () => ({ version: 1, selected: ['unknown'], notes: {} }) }).model; await tick(); assert.equal(invalid.state.kind, 'unavailable'); invalid.dispose();
  const expired = setup({ read: async () => { throw { status: 401 }; } }); await tick(); assert.equal(expired.model.state.kind, 'expired'); assert.equal(expired.gates.length, 1); expired.model.dispose();
});
test('single flight, timeout and expiry prevent late private replies', async () => {
  let finish; let writes = 0; let signal;
  const { model } = setup({ save: (request, options) => { writes++; signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  await tick(); model.edit(id, true); const pending = model.save(); await model.save(); assert.equal(writes, 1);
  await new Promise(resolve => setTimeout(resolve, 40)); await pending; assert.equal(model.state.kind, 'uncertain'); assert.equal(signal.aborted, true);
  model.expire(); finish({ version: 5, selected: [id], notes: {} }); await tick(); assert.deepEqual(model.state, { kind: 'expired' }); model.dispose();
});
test('sign out clears memory, retries endpoint with same key, gates only after revocation', async () => {
  let fail = true; const keys = [];
  const { model, cleared, gates } = setup({ signOut: async options => { keys.push(options.idempotency_key); if (fail) throw Error(); } });
  await tick(); model.edit(id, true); assert.equal(model.signOut(), false); await model.signOut(true); assert.equal(model.state.kind, 'signout-uncertain'); assert.equal(cleared.length, 1); assert.equal(gates.length, 0);
  fail = false; await model.signOut(); assert.equal(keys[0], keys[1]); assert.equal(model.state.kind, 'expired'); assert.equal(gates.length, 1); model.dispose();
});
test('expiry during load ignores late result and disposal is idempotent', async () => {
  let resolve; const { model, gates } = setup({ read: () => new Promise(done => { resolve = done; }) }); model.expire(); resolve(snapshot); await tick(); assert.equal(model.state.kind, 'expired'); assert.equal(gates.length, 1); model.dispose(); model.dispose(); assert.equal(model.state.kind, 'disposed');
});
for (const phase of ['ready', 'dirty', 'saving', 'conflict', 'uncertain', 'unavailable', 'signing-out', 'signout-uncertain']) {
  for (const retirement of ['expire', 'dispose']) test(`${phase} to ${retirement} clears all private state`, async () => {
    let resolve;
    const { model, cleared, gates } = setup({
      read: async () => { if (phase === 'unavailable') throw Error(); return snapshot; },
      save: async () => { if (phase === 'saving') return new Promise(done => { resolve = done; }); throw { status: phase === 'conflict' ? 409 : 503 }; },
      signOut: async () => { if (phase === 'signing-out') return new Promise(done => { resolve = done; }); throw Error(); },
    });
    await tick();
    if (['dirty', 'saving', 'conflict', 'uncertain'].includes(phase)) model.edit(id, true);
    let pending;
    if (['saving', 'conflict', 'uncertain'].includes(phase)) pending = model.save();
    if (phase.startsWith('sign')) pending = model.signOut();
    if (!['saving', 'signing-out'].includes(phase)) await pending;
    assert.equal(model.state.kind, phase);
    model[retirement](); resolve?.(snapshot); await pending;
    assert.deepEqual(model.state, { kind: retirement === 'expire' ? 'expired' : 'disposed' });
    assert.deepEqual(model.properties, []); assert.equal(cleared.length, 1); assert.equal(gates.length, retirement === 'expire' ? 1 : 0);
    model.dispose();
  });
}
test('whole-list load at tenfold count has no per-property requests and IDs survive repeated labels', async () => {
  const candidates = Array.from({ length: 10 }, (_, i) => ({ ...properties[0], id: `synthetic-${i}`, role: 'candidate' }));
  let reads = 0;
  const model = createTourList(candidates, { read: async () => { reads++; return snapshot; }, save: async request => ({ ...request, version: 5 }), signOut: async () => {}, clearPrivateState() {}, returnToGate() {} });
  await tick(); model.edit('synthetic-9', true); model.note('synthetic-9', 'Only this canonical property'); await model.save();
  assert.equal(reads, 1); assert.deepEqual(model.state.base.selected, ['synthetic-9']); assert.equal(model.state.base.notes['synthetic-9'], 'Only this canonical property'); model.dispose();
});
