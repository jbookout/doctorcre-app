import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountMarketTerms } from '../js/market-terms.js';

test('comparison shows recorded coverage and filters confirmed terms', async () => {
  const dom = new JSDOM('<div id="view"></div>');
  const root = dom.window.document.querySelector('#view');
  const calls = [];
  const response = {ok:true,schema_version:'market-terms.v1',rows:[{entity_ref:'d14',fact_key:'rent',value:'35',unit:'USD/sf/year',term_kind:'executed',term_date:'2026-01-01',effective_from:'2026-01-01',effective_to:null,expense_basis:'NNN',confidence:'human_review',sources:[{document_ref:'doc-1',page_start:1,page_end:2}]}],coverage:{recorded_documents:40,canonical_receipts:20,classified_receipts:12,eligible_receipts:1,unsupported_receipts:7,superseded_without_context:4,unclassified_receipts:8,comparable_deals:1}};
  mountMarketTerms(root, {deal:{submarket:'North',use_type:'Office'},read:async args => { calls.push(args); return response; }});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(root.textContent, /40 recorded documents/);
  assert.match(root.textContent, /firm-wide history coverage.*not filtered/i);
  assert.match(root.textContent, /1 of 20 receipts eligible/);
  assert.match(root.textContent, /7 unsupported.*4 superseded without context.*8 unclassified/);
  assert.match(root.textContent, /archive.*unknown/i);
  assert.match(root.textContent, /doc-1/);
  assert.equal(root.querySelector('a').getAttribute('href'), '/deals?deal=d14');
  assert.deepEqual(calls[0], {submarket:'North',use_type:'Office'});
  root.querySelector('[name=submarket]').value = 'South';
  root.querySelector('form').dispatchEvent(new dom.window.Event('submit', {bubbles:true,cancelable:true}));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls[1].submarket, 'South');
});

test('empty and undeployed states are explicit', async () => {
  const dom = new JSDOM('<div></div>');
  const root = dom.window.document.querySelector('div');
  mountMarketTerms(root, {deal:{},read:async () => ({ok:true,schema_version:'market-terms.v1',rows:[],coverage:{recorded_documents:2,canonical_receipts:3,classified_receipts:2,eligible_receipts:1,unsupported_receipts:1,superseded_without_context:0,unclassified_receipts:1,comparable_deals:0}})});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(root.textContent, /No comparable terms/);
  assert.match(root.textContent, /1 of 3 receipts eligible; 1 unsupported, 0 superseded without context, 1 unclassified/);
  mountMarketTerms(root, {deal:{},read:async () => { throw Object.assign(new Error(), {status:404}); }});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(root.textContent, /unavailable until the server update is deployed/);
});

test('only an amended period is labeled superseded', async () => {
  const dom = new JSDOM('<div></div>');
  const root = dom.window.document.querySelector('div');
  const term = {entity_ref:'d1',fact_key:'rent',value:'25',unit:'USD/SF/year',term_kind:'executed',term_date:'2024-01-01',effective_from:'2024-01-01',effective_to:'2025-01-01',confidence:'human_review',sources:[]};
  const rows = [term, {...term,effective_from:'2025-01-01',effective_to:null}, {...term,entity_ref:'d2'}];
  mountMarketTerms(root, {deal:{},read:async () => ({ok:true,schema_version:'market-terms.v1',rows,coverage:{recorded_documents:1,canonical_receipts:3,classified_receipts:3,comparable_deals:2}})});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(root.querySelectorAll('tr.superseded').length, 1);
});
