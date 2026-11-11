import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDealContext, contextDrawerSections } from '../js/pipeline-model.js';
import { createLiveClient } from '../js/live-client.js';
test('F06 optional detail failures are visible without losing successful siblings; denial propagates', async () => {
  const source = {deal:{id:'demo-deal',client_id:'demo-client'},participants:[]};
  const client = {getPartyRecord:async () => {throw Object.assign(new Error('down'),{status:503});},
    getRelationshipNetwork:async () => ({nodes:[{id:'vendor:demo',kind:'vendor',name:'Demo vendor'}],edges:[{from:'vendor:demo',to:'deal:demo-deal',kind:'vendor_deal'}]})};
  const sections = contextDrawerSections(await loadDealContext(client,source));
  assert.ok(sections.some(s=>s.title==='Client' && s.state==='unavailable'));
  assert.ok(sections.some(s=>s.title==='Vendors' && s.lines.includes('Demo vendor')));
  client.getPartyRecord=async () => {throw Object.assign(new Error('denied'),{status:403});};
  await assert.rejects(loadDealContext(client,source),{status:403});
});

test('F06 optional business HTTP read preserves authorization status', async () => {
  const client = createLiveClient({fetchImpl:async () => new Response('{}',{status:401})});
  await assert.rejects(client.getPartyRecord({dataset:'clients',id:'demo'}),{status:401});
});
