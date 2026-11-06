import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticWaiting } from '../scripts/prove-waiting-editor-canonical-reopen.mjs';
import { readCarrInterface } from '../scripts/carr-interface.mjs';
test('registered waiting receipts and inbox snapshots pass production parsers', async () => {
 const contract=await readCarrInterface();assert.equal(contract.home_waiting.schema_version,'home-waiting.v1');assert.equal(contract.home_waiting.read_verb,'read-home-inbox-v5');
 const fixture=await syntheticWaiting();const first=(await fixture.client.read()).items[0];assert.equal(first.waiting_version,1);
 const next=await fixture.seed('New canonical reason');assert.equal(next.waiting_version,2);assert.equal(next.waiting_on.reason,'New canonical reason');assert.deepEqual(next.waiting_on.evidence,['proof:New canonical reason']);
 const snapshot=await fixture.rpc('read-home-inbox-v5',{});assert.throws(()=>fixture.parseSnapshot({...snapshot,items:[{...snapshot.items[0],waiting_version:-1}]}));
});
