import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import { stagingAuth } from '../../scripts/e2e-staging/auth-contract.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

export const fixture = 'fc08d2f4-a951-5679-9f34-40d0f4278842';
export const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
export const reply = body => ({ ok: () => true, status: () => 200, json: async () => body });
export const envelope = body => reply({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });

export function fakeAPI(output, { refuse, unknown, wrongParty = false, linkedLead = false, beforeReadback, sourceRelease = release } = {}) {
  const calls = [], rows = { deals: new Map() };
  let disposed = 0;
  const id = number => `40000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const api = {
    async get(path, options) {
      calls.push({ path, options });
      if (path === stagingAuth.session.path) return reply({ actor: { slug: contract.session.actor_slug }, e2e_principal: contract.session.e2e_principal, csrf_token: 'private-csrf-canary' });
      if (path.startsWith('/api/v1/business/clients/')) { beforeReadback?.(rows); return reply({ record: { id: rows.client, name: rows.clientName ?? 'Synthetic Staging Fixture' } }); }
      if (path.startsWith('/api/tours/detail?')) return reply({ data: rows.tour });
      assert.fail(`Unexpected read ${path}`);
    },
    async post(path, options) {
      const plan = JSON.parse(await readFile(join(output, 'staging-records-plan.json'), 'utf8'));
      assert.equal((await stat(join(output, 'staging-records-plan.json'))).mode & 0o777, 0o600);
      calls.push({ path, options });
      const { name, arguments: args } = path === '/mcp' ? options.data.params : { name: 'tour', arguments: options.data };
      if (name !== 'get-deal-room' && name !== 'read-deal-reconciliation' && name !== 'lead-board' && name !== 'read-doc-conversation' && name !== 'read-invoice-tracker') {
        assert.ok(Object.values(plan.keys).includes(args.idempotency_key), 'write key is durable before request');
        assert.deepEqual(plan.inflight.arguments, args, 'exact mutation intent is durable before request');
      }
      if (name === unknown) throw new Error('private-provider-canary request secret');
      if (name === refuse) return reply({ result: { isError: true, content: [{ type: 'text', text: '{"error":"database_refused_the_statement","fault":"private-provider-canary"}' }] } });
      if (name === 'add-party') {
        if (args.name === 'Synthetic Staging Fixture') return envelope({ needs_confirm: true, candidates: [{ id: wrongParty ? id(99) : fixture, name: 'Synthetic Staging Fixture' }] });
        rows.leadParty = { id: id(6), name: args.name };
        return envelope({ ok: true, party_id: rows.leadParty.id });
      }
      if (name === 'new-client') { rows.client = id(1); return envelope({ ok: true, client_id: rows.client, ref: 'C-001' }); }
      if (name === 'new-deal') { const deal_id = id(rows.deals.size + 2); rows.deals.set(deal_id, { deal_id, id: deal_id, name: args.name, phase: 'pending', owner: null, lane: 'territory', base_version: 1, operating_state: 'active' }); return envelope({ ok: true, deal_id }); }
      if (name === 'get-deal-room') {
        const row = rows.deals.get(args.deal);
        const error = rows.roomError || (row?.phase === 'closed' ? { error: 'not_found', table: 'deal', id: args.deal } : null);
        if (error) return reply({ result: { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] } });
        return envelope(row);
      }
      if (name === 'read-deal-reconciliation') {
        if (rows.reconciliationError) return reply({ result: { isError: true, content: [{ type: 'text', text: JSON.stringify(rows.reconciliationError) }] } });
        const row = rows.deals.get(args.deal);
        return envelope(row && { id: row.id, name: row.name, phase: row.phase, base_version: row.base_version, lane: row.lane });
      }
      if (name === 'set-lead') { const row = rows.deals.get(args.deal); assert.equal(args.base_version, row.base_version); row.owner = 'joe'; row.base_version++; return envelope({ ok: true }); }
      if (name === 'update-deal') { const row = rows.deals.get(args.deal); assert.equal(args.base_version, row.base_version); row.phase = args.fields.phase; row.base_version++; return envelope({ ok: true }); }
      if (name === 'new-lead') { rows.lead = { id: id(4), stage: 'new', name: rows.leadParty?.name || 'Synthetic Staging Fixture', owner: 'joe', party_id: args.party_id, is_client: args.party_id === fixture, linked_client: linkedLead, is_deal: false, suppressed: false }; return envelope({ ok: true, lead_id: rows.lead.id, ref: 'L-001' }); }
      if (name === 'lead-board') return envelope({ detail: rows.lead });
      if (name === 'create-doc-conversation') { rows.conversation = { id: args.idempotency_key, title: args.title, visibility: 'private', archived_at: null }; return envelope({ ok: true, conversation_id: rows.conversation.id }); }
      if (name === 'read-doc-conversation') return envelope({ identity: rows.conversation });
      if (name === 'read-invoice-tracker') return envelope({ entries: [...rows.deals.values()].filter(row => row.phase === 'closed') });
      if (name === 'tour') { rows.tour = { id: id(5), name: args.tour_name, status: 'draft', subject_type: args.subject_type, subject_id: args.subject_id }; return reply({ data: { tour_id: rows.tour.id } }); }
      assert.fail(`Unexpected command ${name}`);
    },
    async dispose() { disposed++; },
  };
  const session = async () => ({ release: sourceRelease, state: { cookies: [{ name: contract.session.cookie, value: 'private-cookie-canary', secure: true, httpOnly: true }] } });
  const requestFactory = async options => { assert.equal(options.baseURL, STAGING_ORIGIN); return api; };
  return { session, requestFactory, calls, rows, disposed: () => disposed };
}
