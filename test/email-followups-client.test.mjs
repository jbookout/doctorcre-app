import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLiveClient } from '../js/live-client.js';
import { createFixtureClient } from '../js/fixture-client.js';

const methods = {
  listEmailProposals: 'list-email-proposals', previewEmailNextStep: 'preview-email-next-step',
  confirmEmailNextStep: 'confirm-email-next-step', previewEmailDealProgress: 'preview-email-deal-progress',
  confirmEmailDealProgress: 'confirm-email-deal-progress', dismissEmailProposal: 'dismiss-email-proposal',
};
const seedUrl = `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}`;

test('both adapters expose the deployed email review verbs and live forwards exact arguments', async () => {
  const calls = [];
  const live = createLiveClient({ fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    const rpc = JSON.parse(init.body); calls.push(rpc.params);
    return Response.json({ result: { content: [{ text: JSON.stringify(rpc.params.name.startsWith('confirm-email') ? { ok: true, contract: rpc.params.name === 'confirm-email-next-step' ? 'email-next-step.v1' : 'email-deal-progress.v1', status: 'confirmed', requires_confirmation: false, ...rpc.params.arguments } : { ok: true }) }] } });
  } });
  const fixture = await createFixtureClient({ seedUrl });
  for (const [method, verb] of Object.entries(methods)) {
    assert.equal(typeof fixture[method], 'function', method);
    const args = method === 'listEmailProposals' ? {} : { proposal_id: '10000000-0000-4000-8000-000000000001', idempotency_key: method };
    await live[method](args);
    assert.deepEqual(calls.at(-1), { name: verb, arguments: args });
  }
});

test('synthetic email proposals preview, refuse stale digests, confirm once, and dismiss at the observed version', async () => {
  const client = await createFixtureClient({ seedUrl });
  const list = await client.listEmailProposals();
  assert.equal(list.schema_version, 'email-proposals.v1'); assert.equal(list.send, false);
  assert.equal(list.proposals.length, 2);
  const row = list.proposals.find(item => item.kind === 'next_step');
  const args = { deal: row.deal, activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote,
    text: row.preview.text, next_date: row.preview.next_date, owner: row.preview.owner };
  const preview = await client.previewEmailNextStep(args);
  await assert.rejects(client.confirmEmailNextStep({ ...args, proposal_digest: `sha256:${'0'.repeat(64)}`, idempotency_key: 'stale' }));
  const request = { ...args, proposal_digest: preview.proposal_digest, idempotency_key: 'confirm-once' };
  const confirmed = await client.confirmEmailNextStep(request);
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(await client.confirmEmailNextStep(request), confirmed);
  assert.equal((await client.listEmailProposals()).proposals.length, 1);
  const remaining = (await client.listEmailProposals()).proposals[0];
  await assert.rejects(client.dismissEmailProposal({ proposal_id: remaining.id, base_version: 99, reason: 'Already handled', idempotency_key: 'conflict' }));
  await client.dismissEmailProposal({ proposal_id: remaining.id, base_version: remaining.version, reason: 'Already handled', idempotency_key: 'dismiss' });
  assert.deepEqual((await client.listEmailProposals()).proposals, []);
});

test('live confirmations recognize the producer receipt without ok and retain exact requests on transport loss', async () => {
  const requests = []; let lost = true;
  const live = createLiveClient({ fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    const rpc = JSON.parse(init.body); requests.push(rpc.params);
    if (lost) { lost = false; throw Error('lost response'); }
    return Response.json({ result: { content: [{ text: JSON.stringify({ contract: 'email-next-step.v1', status: 'confirmed', requires_confirmation: false,
      deal: '20000000-0000-4000-8000-000000000001', source: { activity_id: '30000000-0000-4000-8000-000000000001' }, proposal_digest: rpc.params.arguments.proposal_digest }) }] } });
  } });
  const args = { deal: '20000000-0000-4000-8000-000000000001', activity_id: '30000000-0000-4000-8000-000000000001',
    evidence_quote: 'Please send the revised plan by November 3.', text: 'Send the revised plan', next_date: '2026-11-03', owner: 'joe',
    proposal_digest: `sha256:${'a'.repeat(64)}`, idempotency_key: 'retained-email-confirm' };
  await assert.rejects(live.confirmEmailNextStep(args));
  assert.equal((await live.confirmEmailNextStep(args)).status, 'confirmed');
  assert.deepEqual(requests[0], requests[1]);
});

test('synthetic phase preview refuses tour evidence after the phase has advanced and list keeps a dismissible stale row', async () => {
  const client = await createFixtureClient({ seedUrl });
  const row = (await client.listEmailProposals()).proposals.find(item => item.kind === 'phase_move');
  const args = { deal: row.deal, activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote };
  const preview = await client.previewEmailDealProgress(args);
  await client.confirmEmailDealProgress({ ...args, proposal_digest: preview.proposal_digest, idempotency_key: 'phase-once' });
  await assert.rejects(client.previewEmailDealProgress(args));
  const fresh = await createFixtureClient({ seedUrl });
  await fresh.patchDealField({ deal: row.deal, field: 'phase', value: 'Negotiation', base_event_id: null, idempotency_key: 'advance-elsewhere', change_reason: 'human_stated', human_quote: 'The synthetic deal moved ahead.' });
  const stale = (await fresh.listEmailProposals()).proposals.find(item => item.id === row.id);
  assert.equal(stale.preview, null); assert.ok(stale.preview_error);
});

test('an unknown confirmation does not adopt or block a different source email on the same deal', async () => {
  const requests = [];
  const live = createLiveClient({ fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic-session' });
    const args = JSON.parse(init.body).params.arguments; requests.push(args);
    if (requests.length === 1) throw Error('lost response');
    return Response.json({ result: { content: [{ text: JSON.stringify({ ...args, source: { activity_id: args.activity_id }, contract: 'email-next-step.v1', status: 'confirmed', requires_confirmation: false }) }] } });
  } });
  const first = { deal: '20000000-0000-4000-8000-000000000001', activity_id: '30000000-0000-4000-8000-000000000001',
    evidence_quote: 'Please send the revised plan by November 3.', text: 'Send the revised plan', next_date: '2026-11-03', owner: 'joe',
    proposal_digest: `sha256:${'a'.repeat(64)}`, idempotency_key: 'first-email' };
  await assert.rejects(live.confirmEmailNextStep(first));
  const second = { ...first, activity_id: '30000000-0000-4000-8000-000000000002', idempotency_key: 'second-email' };
  assert.equal((await live.confirmEmailNextStep(second)).status, 'confirmed');
  assert.equal((await live.confirmEmailNextStep(first)).status, 'confirmed');
  assert.deepEqual(requests, [first, second, first]);
});


test('synthetic deal filtering happens before pagination and rejects a cross-deal cursor', async () => {
  const client = await createFixtureClient({ seedUrl });
  const [first, second] = (await client.listEmailProposals()).proposals;
  const selected = await client.listEmailProposals({ deal: second.deal, limit: 1 });
  assert.deepEqual(selected.proposals.map(row => row.id), [second.id]);
  assert.equal(selected.more, false);
  assert.equal(selected.next_cursor, null);
  await assert.rejects(client.listEmailProposals({ deal: second.deal, limit: 1, cursor: first.id }),
    error => error.payload?.error === 'email_proposals_cursor_invalid');
  await client.dismissEmailProposal({ proposal_id: second.id, base_version: second.version, reason: 'Synthetic review complete', idempotency_key: 'scope-dismiss' });
  assert.deepEqual((await client.listEmailProposals({ deal: second.deal, limit: 1, cursor: second.id })).proposals, []);
  assert.deepEqual((await client.listEmailProposals({ deal: 'unknown-deal', limit: 1 })).proposals, []);
  assert.deepEqual((await client.listEmailProposals()).proposals.map(row => row.id), [first.id]);
});
