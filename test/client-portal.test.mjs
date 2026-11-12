import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientPortalClient } from '../js/client-portal-client.js';
import { carrInterface } from "./carr-contract.mjs";

const portal = {
  slug: 'demo-practice',
  roadmap: { current_phase: 'negotiation', phases: [
    { slug: 'research', label: 'Research' }, { slug: 'negotiation', label: 'Negotiation' },
    { slug: 'closed', label: 'Closed' },
  ] },
  materials: [{ kind: 'document', title: 'Demo terms', content: 'Shared terms only.' }],
};
const response = payload => new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }));

test('portal reader sends only the selected portal and password over authenticated same-origin MCP', async () => {
  let request;
  const client = createClientPortalClient({ fetchImpl: async (path, init) => {
    request = { path, init };
    return response({ ok: true, schema_version: 'client-portal.v1', portal });
  } });
  assert.deepEqual(await client.read({ slug: 'demo-practice', password: 'synthetic-password' }), {...portal,roadmap:{current_phase:null,phases:[]},publications:[]});
  assert.equal(request.path, '/mcp');
  assert.equal(request.init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(request.init.body).params, {
    name: 'read-client-portal', arguments: { slug: 'demo-practice', password: 'synthetic-password' },
  });
});

test('portal reader refuses another portal, unsupported versions and incomplete material', async () => {
  const valid = { ok: true, schema_version: 'client-portal.v1', portal };
  for (const payload of [
    { ...valid, schema_version: 'client-portal.v2' },
    { ...valid, portal: { ...portal, slug: 'another-practice' } },
    { ...valid, portal: { ...portal, materials: [{ kind: 'note', title: 'Internal', content: 'Do not share' }] } },
    { ...valid, portal: { ...portal, materials: [{ kind: 'report', title: 'Incomplete' }] } },
    { ok: false, error: 'portal_access_denied' },
  ]) {
    const client = createClientPortalClient({ fetchImpl: async () => response(payload) });
    await assert.rejects(client.read({ slug: 'demo-practice', password: 'synthetic-password' }), /Portal unavailable/);
  }
});

test('portal projection never exposes additional internal fields from a response', async () => {
  const client = createClientPortalClient({ fetchImpl: async () => response({ ok: true, schema_version: 'client-portal.v1', portal: {
    ...portal, internal_note: 'Synthetic internal note',
    materials: [{ ...portal.materials[0], internal_note: 'Not shared' }],
  } }) });
  assert.deepEqual(await client.read({ slug: 'demo-practice', password: 'synthetic-password' }), {...portal,roadmap:{current_phase:null,phases:[]},publications:[]});
});

test('portal read pins the exact isolated server contract without widening other consumers', async () => {
  const { readFile } = await import('node:fs/promises');
  const contract = carrInterface;
  assert.ok(contract.mcp_operations.includes('read-client-portal'));
  assert.equal(contract.mcp_read_contracts['read-client-portal'].write, true);
  assert.equal(contract.mcp_read_contracts['read-client-portal'].schema_version, 'client-portal.v1');
  assert.equal(contract.mcp_read_contracts['read-client-portal'].producer.source_commit, '274bb5cc6bcc06c93edd2e4c4162b60554fda165');
  assert.deepEqual(contract.mcp_read_contracts['read-client-portal'].arguments, ['slug', 'password']);
});

test('portal transport never returns material after refusal, HTTP outage or an expired read', async () => {
  for (const options of [
    { fetchImpl: async () => new Response('', { status: 401 }) },
    { fetchImpl: async () => new Response('', { status: 503 }) },
    { fetchImpl: async () => new Response(JSON.stringify({ result: { isError: true, content: [{ type: 'text', text: '{"error":"portal_access_denied"}' }] } })) },
    { timeoutMs: 5, fetchImpl: () => new Promise(() => {}) },
  ]) {
    const client = createClientPortalClient(options);
    await assert.rejects(client.read({ slug: 'demo-practice', password: 'synthetic-password' }), /Portal unavailable/);
  }
});

test('publication contract accepts explicit milestones and file metadata with an empty roadmap',async()=>{
  const projection={slug:'demo-practice',roadmap:{current_phase:null,phases:[]},materials:[],publications:[{kind:'milestone',title:'Published step',content:'Client update'},{kind:'deliverable',title:'Final report',deliverable:{id:'11111111-1111-4111-8111-111111111111',filename:'report.pdf',mime:'application/pdf',bytes:400}}]};
  const client=createClientPortalClient({fetchImpl:async()=>response({ok:true,schema_version:'client-portal.v1',portal:projection})});
  assert.deepEqual(await client.read({slug:projection.slug,password:'synthetic-password'}),projection);
});

test('legacy roadmap phases never become published client milestones',async()=>{
  const client=createClientPortalClient({fetchImpl:async()=>response({ok:true,schema_version:'client-portal.v1',portal})});
  const visible=await client.read({slug:portal.slug,password:'synthetic-password'});
  assert.deepEqual(visible.roadmap,{current_phase:null,phases:[]});
  assert.deepEqual(visible.publications,[]);
});
