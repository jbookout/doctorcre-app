import test from 'node:test';
import assert from 'node:assert/strict';
import { relationshipValid, validListPayload, validRecordPayload, parseViewState, viewHref } from '../js/workspace-business-model.js';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';

test('W5 validates the complete partnership payload and rejects malformed evidence before rendering', () => {
  const list=directoryFixture('http://demo.example/api/v1/business/vendors');
  assert.equal(validListPayload(list,'vendors'),true);
  const record=directoryFixture(`http://demo.example/api/v1/business/vendors/${list.rows[0].id}`);
  assert.equal(validRecordPayload(record,'vendors'),true);
  const stats=list.rows[0].relationship;
  for(const patch of [{win_rate:2},{deals_worked:-1},{computed_tier:'Trusted'},{coverage_verified_at:null},{recent_entries:{}},{introductions:[{}]},{override:{tier:'Trial',reason:'',recorded_by:'joe',recorded_at:'2026-10-01'}}]) assert.equal(relationshipValid({...stats,...patch}),false,JSON.stringify(patch));
  assert.equal(relationshipValid({...stats,coverage_verified_at:null,deals_worked:null,deals_referred:null,win_rate:null,computed_tier:'Unrated'}),true);
  assert.equal(validRecordPayload({...record,record:{...record.record,loan_programs:42}},'vendors'),false);
});

test('W5 owner and territory survive canonical navigation; client territory is dropped', () => {
  const vendor=parseViewState('/vendors','?owner=dell&territory=Demo%20North&sort=last_deal_asc').query;
  assert.equal(vendor.owner,'dell');assert.equal(vendor.territory,'Demo North');assert.equal(vendor.sort,'last_deal_asc');
  assert.equal(new URL(viewHref(vendor),'http://demo.example').searchParams.get('territory'),'Demo North');
  assert.equal(parseViewState('/clients','?territory=Demo&owner=other').query.territory,'');
  assert.equal(parseViewState('/clients','?owner=other').query.owner,'all');
});
