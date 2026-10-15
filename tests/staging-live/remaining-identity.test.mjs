import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStagingRecords } from '../../scripts/e2e-staging/records.mjs';
import { fakeAPI, reply } from './record-fixture.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';
import { openRun } from '../../scripts/e2e-staging/run-limits.mjs';

beforeEach(admitFixtureRun);
test('fixed party setup refuses a different selected client or vendor role before admitting fixtures', async t => {
  for (const variant of ['client', 'vendor']) {
    const output = await mkdtemp(join(tmpdir(), 'remaining-identity-'));
    const run = openRun(output, { runId: `remaining-identity-${variant}`, events: null });
    t.after(() => run.dispose());
    t.after(() => rm(output, { recursive: true, force: true }));
    const fake = fakeAPI(output), factory = fake.requestFactory;
    fake.requestFactory = async options => {
      const api = await factory(options), get = api.get.bind(api);
      api.get = async (path, options) => {
        const response = await get(path, options);
        if (!path.includes('/relationships?')) return response;
        const value = await response.json();
        if (variant === 'client') {
          value.nodes[0].record_id = '99999999-0000-4000-8000-000000000001';
          value.edges.find(edge => edge.kind === 'client_deal').from = 'party:99999999-0000-4000-8000-000000000002';
        } else value.nodes[0].kind = 'vendor';
        return reply(value);
      };
      return api;
    };
    await assert.rejects(prepareStagingRecords(output, { ...fake, run }), /stopped at readback/);
    const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
    assert.equal(plan.state, 'pending');
    await assert.rejects(prepareStagingRecords(output, { ...fake, run }), /partial plan requires reconciliation/);
  }
});

test('missing relationship seed proof refuses reuse with a precise prerequisite and no new fixture writes', async t => {
  const output = await mkdtemp(join(tmpdir(), 'remaining-referral-prerequisite-'));
  const run = openRun(output, { runId: 'remaining-referral-prerequisite', events: null });
  t.after(() => { run.dispose(); return rm(output, { recursive: true, force: true }); });
  const fake = fakeAPI(output);
  await prepareStagingRecords(output, { ...fake, run });
  fake.calls.length = 0;
  await assert.rejects(prepareStagingRecords(output, { ...fake, run, reuseOnly: true, relationshipFixture: true }),
    { code: 'staging-fixture-relationship-prerequisite' });
  assert.deepEqual(fake.calls.filter(row => row.path === '/mcp').map(row => row.options.data.params.name), ['get-deal-room']);
});

const relationshipTarget = {
  project: { id: 'synthetic-staging-project', name: 'carr-staging-replacement-synthetic' },
  branch: { id: 'br-synthetic', name: 'main' },
  endpoint: { id: 'ep-synthetic', host: 'ep-synthetic.us-east-2.aws.neon.tech' }, database: 'neondb',
};
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const textHash = value => createHash('sha256').update(value).digest('hex');
function relationshipId(run, role) {
  const namespace = '439206abd73a5c1b8a20531e536e5804';
  const bytes = createHash('sha1').update(Buffer.from(namespace, 'hex')).update(`relationship:${role}:${run}`).digest().subarray(0, 16);
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
  const id = bytes.toString('hex');
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}
function relationshipProof(plan) {
  const label = `Synthetic staging QA ${plan.run}`, north = 'Synthetic Staging QA North', south = 'Synthetic Staging QA South';
  const id = role => relationshipId(plan.run, role);
  const note = role => `Fictional staging QA ${role} referral for fixture ${plan.run}.`;
  const association = (role, from, to) => ({ id: id(role), from_party_id: from, to_party_id: to,
    kind: 'referred', via_party_id: null, occurred_on: plan.observed_at.slice(0,10), note: note(role), attribution: 'system' });
  const attribution = (role, party, deal, noteRole) => ({ id: id(role), party_id: party, deal_id: deal,
    kind: 'referred', via_party_id: null, occurred_on: plan.observed_at.slice(0,10), note: note(noteRole), attribution: 'system' });
  const rows = {
    destination_party: { id: id('destination_party'), name: `${label} referred client`, kind: 'org', city: north },
    destination_client: { id: id('destination_client'), party_id: id('destination_party'), status: 'engaged' },
    destination_deal: { id: id('destination_deal'), name: `${label} referred deal`, client_id: id('destination_client'),
      owner: 'joe', phase: 'pending', lane: 'territory', deal_type: 'startup' },
    fixed_party: { id: plan.records.party.id, city: north },
    owned_vendor: { id: plan.records.vendor.id, party_id: plan.records.vendor_party.id, territory: south },
    referral_association: association('referral_association', plan.records.party.id, id('destination_party')),
    vendor_association: association('vendor_association', plan.records.vendor_party.id, plan.records.party.id),
    referral_attribution: attribution('referral_attribution', plan.records.party.id, id('destination_deal'), 'referral_association'),
    vendor_attribution: attribution('vendor_attribution', plan.records.vendor_party.id, plan.records.deal.id, 'vendor_association'),
  };
  const nodes = [
    { id: `party:${plan.records.party.id}`, kind: 'client', record_id: plan.records.client.id, name: plan.records.party.name, territory: north, verticals: [] },
    { id: `deal:${plan.records.deal.id}`, kind: 'deal', record_id: plan.records.deal.id, name: plan.records.deal.name, territory: north, verticals: [] },
    { id: `party:${plan.records.vendor_party.id}`, kind: 'vendor', record_id: plan.records.vendor.id, name: plan.records.vendor.name, territory: south, verticals: [] },
    { id: `party:${id('destination_party')}`, kind: 'client', record_id: id('destination_client'), name: rows.destination_party.name, territory: north, verticals: [] },
    { id: `deal:${id('destination_deal')}`, kind: 'deal', record_id: id('destination_deal'), name: rows.destination_deal.name, territory: north, verticals: [] },
  ];
  const edges = [
    { id: `client-deal:${plan.records.deal.id}`, kind: 'client_deal', from: nodes[0].id, to: nodes[1].id, via: null },
    { id: `client-deal:${id('destination_deal')}`, kind: 'client_deal', from: nodes[3].id, to: nodes[4].id, via: null },
    { id: `evidence:${plan.records.party.id}:${id('destination_deal')}:referred`, kind: 'referred', from: nodes[0].id, to: nodes[4].id, via: null, detail: note('referral_association') },
    { id: `evidence:${plan.records.vendor_party.id}:${plan.records.deal.id}:referred`, kind: 'referred', from: nodes[2].id, to: nodes[1].id, via: null, detail: note('vendor_association') },
  ];
  const observed = Date.now();
  const response = { schema: 'carr-relationship-network.v1', observed_at: new Date(observed).toISOString(),
    valid_until: new Date(observed+60000).toISOString(), nodes, edges,
    referrals: [nodes[0], nodes[2]].map(node => ({ node_id: node.id, deals: 1, won: 0, lost: 0, win_rate: null })), suggestions: [] };
  const tables = { destination_party: 'party', destination_client: 'client', destination_deal: 'deal', fixed_party: 'party',
    owned_vendor: 'vendor', referral_association: 'party_association', vendor_association: 'party_association',
    referral_attribution: 'deal_attribution', vendor_attribution: 'deal_attribution' };
  const receipts = Object.fromEntries(Object.entries(rows).map(([role, row]) => {
    const update = ['fixed_party', 'owned_vendor'].includes(role);
    return [role, { operation: update ? 'update' : 'insert', table: tables[role], row_id: row.id,
      before_sha256: update ? hash({ ...row, [role === 'fixed_party' ? 'city' : 'territory']: null }) : null, after_sha256: hash(row) }];
  }));
  return { schema: 'doctorcre-staging-relationship-fixture.v1', fixture_run: plan.run, source_pair: plan.release,
    provenance: { kind: 'raw-sql-fixture', readback: 'separate-committed-readonly-connection' },
    recorded_plan_observed_at: plan.observed_at, verified_target: structuredClone(relationshipTarget),
    party_id: plan.records.party.id, client_id: plan.records.client.id, deal_id: plan.records.deal.id,
    relationship_referral_deal: { id: rows.destination_deal.id, name: rows.destination_deal.name,
      client_id: rows.destination_client.id, party_id: rows.destination_party.id },
    rows, row_sha256: Object.fromEntries(Object.entries(rows).map(([role,row]) => [role, hash(row)])), receipts,
    original_note_sha256: { referral: textHash(note('referral_association')), vendor: textHash(note('vendor_association')) },
    projection: { response, response_sha256: hash(response) } };
}
async function relationshipSetup(t, suffix) {
  const output = await mkdtemp(join(tmpdir(), 'remaining-relationship-proof-'));
  const run = openRun(output, { runId: `remaining-relationship-${suffix}`, events: null });
  t.after(() => { run.dispose(); return rm(output, { recursive: true, force: true }); });
  const fake = fakeAPI(output);
  await prepareStagingRecords(output, { ...fake, run, vendorFixture: true });
  const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
  const proof = relationshipProof(plan), fresh = structuredClone(proof.projection.response);
  const clientReadback = { record: { id: proof.rows.destination_client.id, name: proof.rows.destination_party.name,
    party_id: proof.rows.destination_party.id, status: 'engaged', city: proof.rows.destination_party.city } };
  const dealReadback = { deal_id: proof.rows.destination_deal.id, name: proof.rows.destination_deal.name,
    client_id: proof.rows.destination_client.id, owner: 'joe', phase: 'pending', lane: 'territory', deal_type: 'startup' };
  const factory = fake.requestFactory;
  fake.requestFactory = async options => {
    const api = await factory(options), get = api.get.bind(api), post = api.post.bind(api);
    api.get = async (path, options) => {
      if (path.includes('/relationships?')) return reply(fresh);
      if (path === `/api/v1/business/clients/${proof.relationship_referral_deal.client_id}`)
        return reply(clientReadback);
      return get(path, options);
    };
    api.post = async (path, options) => {
      if (path === '/mcp' && options.data.params.name === 'get-deal-room' && options.data.params.arguments.deal === proof.rows.destination_deal.id)
        return reply({ jsonrpc: '2.0', id: options.data.id, result: { content: [{ type: 'text', text: JSON.stringify(dealReadback) }] } });
      return post(path, options);
    };
    return api;
  };
  await mkdir(join(output, 'private'), { mode: 0o700 });
  const persist = value => writeFile(join(output, 'private', 'relationship-fixture-proof.json'), JSON.stringify(value), { mode: 0o600 });
  const prepare = options => prepareStagingRecords(output, { ...fake, run, reuseOnly: true, relationshipFixture: true,
    relationshipFixtureTarget: relationshipTarget, ...options });
  fake.calls.length = 0;
  return { output, fake, plan, proof, fresh, clientReadback, dealReadback, persist, prepare };
}

test('relationship installer refuses the reviewer minimal proof even with a valid fresh projection', async t => {
  const fixture = await relationshipSetup(t, 'minimal');
  const { proof } = fixture;
  const minimal = Object.fromEntries(['schema', 'fixture_run', 'source_pair', 'party_id', 'client_id', 'deal_id', 'relationship_referral_deal'].map(key => [key, proof[key]]));
  minimal.provenance = { kind: 'raw-sql-fixture' };
  await fixture.persist(minimal);
  await assert.rejects(fixture.prepare(), { code: 'staging-fixture-relationship-prerequisite' });
  const after = JSON.parse(await readFile(join(fixture.output, 'staging-records-plan.json'), 'utf8'));
  assert.equal(after.relationship_fixture, undefined);
  assert.equal(after.fixture_proofs?.relationship, undefined);
  assert.deepEqual(fixture.fake.calls.filter(call => call.path === '/mcp').map(call => call.options.data.params.name), ['get-deal-room']);
});

test('relationship installer verifies a reused party projection through the recorded client and deal lineage', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
  const fixture = await relationshipSetup(t, 'projected-client');
  const otherClient = '99999999-0000-4000-8000-000000000001';
  fixture.proof.projection.response.nodes[0].record_id = otherClient;
  fixture.proof.projection.response_sha256 = hash(fixture.proof.projection.response);
  fixture.fresh.nodes[0].record_id = otherClient;
  await fixture.persist(fixture.proof);
  await fixture.prepare();
  const after = JSON.parse(await readFile(join(fixture.output, 'staging-records-plan.json'), 'utf8'));
  assert.equal(after.fixture_proofs.relationship.state, 'verified');
  assert.equal(after.party_reuse.client_id, fixture.plan.records.client.id);
  assert.equal(after.relationship_fixture.client_id, fixture.plan.records.client.id);
  assert.ok(fixture.fake.calls.some(call => call.path === `/api/v1/business/clients/${fixture.plan.records.client.id}`));
  assert.equal(fixture.fake.calls.some(call => call.path === `/api/v1/business/clients/${otherClient}`), false);
});

test('relationship installer binds complete mutation evidence to trusted target and fresh readback on every reuse', async t => {
  const fixture = await relationshipSetup(t, 'complete');
  await fixture.persist(fixture.proof);
  await fixture.prepare();
  let after = JSON.parse(await readFile(join(fixture.output, 'staging-records-plan.json'), 'utf8'));
  const binding = after.fixture_proofs.relationship;
  assert.equal(binding.schema, 'staging-relationship-fixture-binding.v1');
  assert.equal(binding.state, 'verified');
  assert.equal(binding.verified_target_sha256, hash(relationshipTarget));
  assert.equal(binding.proof_content_sha256, hash(fixture.proof));
  assert.equal(binding.current_readback.network_response_sha256, hash(fixture.fresh));
  assert.equal(binding.current_readback.client_response_sha256, hash(fixture.clientReadback));
  assert.equal(binding.current_readback.deal_response_sha256, hash(fixture.dealReadback));
  assert.equal(after.relationship_fixture.state, 'verified');
  await fixture.prepare();
  const edge = fixture.fresh.edges.find(edge => edge.kind === 'referred'), original = edge.detail;
  edge.detail = 'Different fictional note';
  await assert.rejects(fixture.prepare(), { code: 'staging-fixture-relationship-prerequisite' });
  after = JSON.parse(await readFile(join(fixture.output, 'staging-records-plan.json'), 'utf8'));
  assert.equal(after.fixture_proofs.relationship.state, 'pending-readback');
  assert.equal(after.fixture_proofs.relationship.current_readback, undefined);
  assert.equal(after.relationship_fixture, undefined);
  edge.detail = original;
  await fixture.prepare();
  after = JSON.parse(await readFile(join(fixture.output, 'staging-records-plan.json'), 'utf8'));
  assert.equal(after.fixture_proofs.relationship.state, 'verified');
});

test('relationship installer rejects incomplete or mismatched target, mutation and original projection evidence', async t => {
  const variants = [
    ['trusted-target', (proof, options) => { options.relationshipFixtureTarget = undefined; }],
    ['production-target', (proof, options) => { options.relationshipFixtureTarget = { ...relationshipTarget, project: { id: 'steep-field-48688294', name: 'carr-staging-replacement-synthetic' } }; proof.verified_target = options.relationshipFixtureTarget; }],
    ['different-target', proof => { proof.verified_target.endpoint.id = 'ep-other'; }],
    ['readback-provenance', proof => { delete proof.provenance.readback; }],
    ['missing-source', proof => { delete proof.source_pair; }],
    ['missing-receipts', proof => { delete proof.receipts; }],
    ['observation-binding', proof => { proof.recorded_plan_observed_at = new Date(0).toISOString(); }],
    ['missing-row', proof => { delete proof.rows.vendor_attribution; }],
    ['creation-receipt', proof => { delete proof.receipts.destination_client; }],
    ['wrong-row-id', proof => { proof.receipts.referral_association.row_id = proof.rows.vendor_association.id; }],
    ['row-hash', proof => { proof.row_sha256.destination_party = 'a'.repeat(64); }],
    ['receipt-hash', proof => { proof.receipts.destination_deal.after_sha256 = 'a'.repeat(64); }],
    ['update-before', proof => { proof.receipts.fixed_party.before_sha256 = 'a'.repeat(64); }],
    ['row-value', proof => { proof.rows.destination_deal.owner = 'dell'; proof.row_sha256.destination_deal = hash(proof.rows.destination_deal); proof.receipts.destination_deal.after_sha256 = proof.row_sha256.destination_deal; }],
    ['original-note', proof => { proof.original_note_sha256.referral = 'a'.repeat(64); }],
    ['projection-hash', proof => { proof.projection.response_sha256 = 'a'.repeat(64); }],
    ['projection-edge', proof => { proof.projection.response.edges[2].via = proof.projection.response.nodes[2].id; proof.projection.response_sha256 = hash(proof.projection.response); }],
    ['projection-metrics', proof => { proof.projection.response.referrals[0].deals = 2; proof.projection.response_sha256 = hash(proof.projection.response); }],
    ['fresh-note', (proof, options, fresh) => { fresh.edges[2].detail = 'Different fictional note'; }],
    ['fresh-client', (proof, options, fresh, fixture) => { fixture.clientReadback.record.party_id = fixture.plan.records.party.id; }],
    ['fresh-deal', (proof, options, fresh, fixture) => { fixture.dealReadback.client_id = fixture.plan.records.client.id; }],
    ['fresh-territory', (proof, options, fresh) => { fresh.nodes[2].territory = 'Different South'; }],
  ];
  for (const [name, alter] of variants) await t.test(name, async t => {
    const fixture = await relationshipSetup(t, name), options = {};
    alter(fixture.proof, options, fixture.fresh, fixture);
    await fixture.persist(fixture.proof);
    await assert.rejects(fixture.prepare(options), { code: 'staging-fixture-relationship-prerequisite' });
    const after = JSON.parse(await readFile(join(fixture.output, 'staging-records-plan.json'), 'utf8'));
    assert.equal(after.relationship_fixture, undefined);
    assert.equal(after.fixture_proofs?.relationship?.state, name.startsWith('fresh-') || name === 'projection-metrics' ? 'pending-readback' : undefined);
    assert.equal(after.fixture_proofs?.relationship?.current_readback, undefined);
  });
});

test('relationship refresh revokes prior verification before early readback failures and permits read-only recovery', async t => {
  for (const stage of ['network', 'client', 'deal']) await t.test(stage, async t => {
    const fixture = await relationshipSetup(t, `early-${stage}`);
    await fixture.persist(fixture.proof);
    await fixture.prepare();
    let restore;
    if (stage === 'network') {
      const node = fixture.fresh.nodes[0];
      node.kind = 'vendor';
      restore = () => { node.kind = 'client'; };
    } else if (stage === 'client') {
      const original = fixture.fake.rows.client;
      fixture.fake.rows.client = fixture.proof.relationship_referral_deal.client_id;
      restore = () => { fixture.fake.rows.client = original; };
    } else {
      const row = fixture.fake.rows.deals.get(fixture.plan.records.deal.id), original = row.deal_id;
      row.deal_id = fixture.proof.relationship_referral_deal.id;
      restore = () => { row.deal_id = original; };
    }
    await assert.rejects(fixture.prepare(), /stopped at readback/);
    let after = JSON.parse(await readFile(join(fixture.output, 'staging-records-plan.json'), 'utf8'));
    assert.equal(after.fixture_proofs.relationship.state, 'pending-readback');
    assert.equal(after.fixture_proofs.relationship.current_readback, undefined);
    assert.equal(after.relationship_fixture, undefined);
    restore();
    fixture.fake.calls.length = 0;
    await fixture.prepare();
    after = JSON.parse(await readFile(join(fixture.output, 'staging-records-plan.json'), 'utf8'));
    assert.equal(after.fixture_proofs.relationship.state, 'verified');
    assert.ok(fixture.fake.calls.filter(row => row.path === '/mcp').every(row =>
      ['get-deal-room', 'read-deal-reconciliation', 'read-invoice-tracker', 'lead-board', 'read-doc-conversation'].includes(row.options.data.params.name)));
  });
});
