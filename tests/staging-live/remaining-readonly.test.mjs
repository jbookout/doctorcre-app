import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { assertRelationshipFixture } from '../../scripts/e2e-staging/readonly-journeys.mjs';

const partyId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const dealId = '33333333-3333-4333-8333-333333333333';
const otherPartyId = '44444444-4444-4444-8444-444444444444';
const referredPartyId = '55555555-5555-4555-8555-555555555555';
const referredClientId = '66666666-6666-4666-8666-666666666666';
const referredDealId = '77777777-7777-4777-8777-777777777777';
const hash = value => createHash('sha256').update(value).digest('hex');
const plan = { records: {
  party: { id: partyId, name: 'Synthetic QA Client' },
  client: { id: clientId, ref: 'C-1' },
  deal: { id: dealId, name: 'Synthetic QA Deal' },
  relationship_referral_deal: { id: referredDealId, name: 'Synthetic QA Referred Deal', client_id: referredClientId, party_id: referredPartyId },
} };

function networkFixture() {
  const now = Date.now();
  return {
    schema: 'carr-relationship-network.v1',
    observed_at: new Date(now - 1_000).toISOString(), valid_until: new Date(now + 59_000).toISOString(),
    nodes: [
      { id: `party:${partyId}`, kind: 'client', record_id: clientId, name: 'Synthetic QA Client', territory: 'QA North', verticals: [] },
      { id: `deal:${dealId}`, kind: 'deal', record_id: dealId, name: 'Synthetic QA Deal', territory: 'QA North', verticals: [] },
      { id: `party:${otherPartyId}`, kind: 'vendor', record_id: otherPartyId, name: 'Synthetic QA Referrer', territory: 'QA South', verticals: [] },
      { id: `party:${referredPartyId}`, kind: 'client', record_id: referredClientId, name: 'Synthetic QA Referred Client', territory: 'QA North', verticals: [] },
      { id: `deal:${referredDealId}`, kind: 'deal', record_id: referredDealId, name: 'Synthetic QA Referred Deal', territory: 'QA North', verticals: [] },
    ],
    edges: [
      { id: `client-deal:${dealId}`, from: `party:${partyId}`, to: `deal:${dealId}`, kind: 'client_deal', via: null },
      { id: `client-deal:${referredDealId}`, from: `party:${referredPartyId}`, to: `deal:${referredDealId}`, kind: 'client_deal', via: null },
      { id: `evidence:${partyId}:${referredDealId}:referred`, from: `party:${partyId}`, to: `deal:${referredDealId}`,
        kind: 'referred', via: null, detail: 'Fictional QA referral evidence only.' },
    ],
    referrals: [
      { node_id: `party:${partyId}`, deals: 1, won: 0, lost: 0, win_rate: null },
      { node_id: `party:${otherPartyId}`, deals: 1, won: 1, lost: 0, win_rate: 1 },
    ],
    suggestions: [],
  };
}

test('W14 fixture admission binds the selected client, exact original referral evidence, metrics and territory contrast', () => {
  const network = networkFixture();
  assert.deepEqual(assertRelationshipFixture(network, plan), {
    schema: 'staging-relationship-fixture-proof.v1', state: 'verified',
    party_id: partyId, client_id: clientId, deal_id: dealId,
    referral_deal_id: referredDealId, referral_client_id: referredClientId, referral_party_id: referredPartyId,
    observed_at: network.observed_at, valid_until: network.valid_until,
    network_response_sha256: hash(JSON.stringify(network)),
    client_deal_edge_id: `client-deal:${dealId}`, evidence_edge_id: `evidence:${partyId}:${referredDealId}:referred`,
    evidence_detail_sha256: hash('Fictional QA referral evidence only.'),
    referral_metrics: { deals: 1, won: 0, lost: 0, win_rate: null }, territory_sha256: hash('QA North'),
    total_referrals: 2, same_territory_referrals: 1, other_territory_referrals: 1,
  });
});

test('W14 fixture admission refuses ambiguous identity, absent referral evidence and missing territory prerequisites', () => {
  const cases = [
    ['selected-client-identity-unproved', network => { network.nodes[0].record_id = otherPartyId; }],
    ['selected-client-identity-unproved', network => { network.nodes[0].kind = 'vendor'; }],
    ['selected-client-identity-unproved', network => { network.nodes[0].name = 'Another synthetic client'; }],
    ['selected-client-identity-unproved', network => { network.nodes[1].record_id = otherPartyId; }],
    ['client-deal-association-unproved', network => { network.edges[0].via = `party:${otherPartyId}`; }],
    ['referral-evidence-unproved', network => { network.edges.pop(); }],
    ['referral-evidence-unproved', network => { network.edges[2].detail = '  '; }],
    ['referral-evidence-unproved', network => { network.edges[2].kind = 'worked'; }],
    ['referral-fixture-identity-unproved', network => { network.nodes[3].record_id = clientId; }],
    ['referral-fixture-identity-unproved', network => { network.nodes[4].name = 'Another synthetic referred deal'; }],
    ['owned-referral-metrics-unproved', network => { network.referrals.shift(); }],
    ['owned-referral-metrics-unproved', network => { network.referrals[0].deals = 0; }],
    ['owned-territory-unproved', network => { network.nodes[0].territory = ''; }],
    ['contrasting-territory-referrals-unproved', network => { network.nodes[2].territory = 'QA North'; }],
    ['contrasting-territory-referrals-unproved', network => { network.nodes[2].territory = ''; }],
    ['fresh-network-unproved', network => { network.observed_at = new Date(Date.now() - 120_000).toISOString(); }],
    ['fresh-network-unproved', network => { network.referrals[0].win_rate = 1; }],
    ['fresh-network-unproved', network => { network.nodes.push({ ...network.nodes[0] }); }],
  ];
  for (const [reason, alter] of cases) {
    const network = networkFixture();
    alter(network);
    assert.throws(() => assertRelationshipFixture(network, plan), {
      code: 'staging-fixture-relationship-prerequisite', reason,
    });
  }
});

test('W14 fixture admission refuses a missing destination or a self-referral fixture', () => {
  for (const alter of [
    value => { delete value.records.relationship_referral_deal; },
    value => { value.records.relationship_referral_deal.id = dealId; },
    value => { value.records.relationship_referral_deal.party_id = partyId; },
    value => { value.records.relationship_referral_deal.client_id = clientId; },
  ]) {
    const changed = structuredClone(plan);
    alter(changed);
    assert.throws(() => assertRelationshipFixture(networkFixture(), changed), {
      code: 'staging-fixture-relationship-prerequisite', reason: 'referral-fixture-identity-unproved',
    });
  }
});
