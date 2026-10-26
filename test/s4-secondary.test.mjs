import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadEvidence, renderEvidence, mountEvidence } from '../js/correspondence.js';
import { loadDealContext, contextDrawerSections } from '../js/pipeline-model.js';
import { createLiveClient } from '../js/live-client.js';
import { identity, found, readiness, meeting } from './fixtures/correspondence.mjs';

const detail = { activities: [{ ...meeting, kind:'correspondence', detail:{native_identity:identity} }, meeting] };

test('F06 correspondence unavailable is visible, retry recovers, and empty differs from failure', async () => {
  let fail = true;
  const client = { correspondenceReadiness:async () => readiness, readCorrespondenceThread:async () => {
    if (fail) throw Object.assign(new Error('unavailable'), {status:503});
    return found;
  } };
  const view = await loadEvidence(client, detail);
  assert.match(renderEvidence(view), /Threads unavailable/);
  assert.match(renderEvidence(view), /data-evidence-retry/);
  assert.match(renderEvidence({threads:{state:'ready',items:[]}}), /No linked evidence/);
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main');
  const dispose = mountEvidence(root, {client,detail});
  await new Promise(r => setTimeout(r, 10));
  fail = false;
  root.querySelector('[data-evidence-retry]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.ok(root.querySelector('[data-kind=thread]'));
  dispose(); dom.window.close();
});

test('F06 denied correspondence clears sibling evidence and offers sign-in', async () => {
  const view = await loadEvidence({correspondenceReadiness:async () => readiness,
    readCorrespondenceThread:async () => { throw Object.assign(new Error('denied'),{status:401}); }},detail);
  const html = renderEvidence(view);
  assert.match(html,/Sign in/);
  assert.doesNotMatch(html,/data-kind="meeting"/);
});

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
