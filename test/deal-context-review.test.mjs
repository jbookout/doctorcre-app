import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDealContext,contextDrawerSections} from '../js/pipeline-model.js';
import {closedDeals,lostDeals,localDeals} from '../js/local-deals-model.js';
test('uses the actual client and exact vendor association, never a participant party id',async()=>{
 const calls=[];
 const context=await loadDealContext({getPartyRecord:async arg=>{calls.push(arg);return {record:{name:'Demo Client'}};},getRelationshipNetwork:async()=>({nodes:[{id:'party:demo-party',record_id:'demo-vendor',kind:'vendor',name:'Demo Vendor'}],edges:[{from:'party:demo-party',to:'deal:demo-deal',kind:'referred'}]})},{deal:{id:'demo-deal',client_id:'demo-client',account_client_id:'demo-parent'},participants:[{party_id:'wrong-id',name:'Demo Contact',role:'listing_side'}]});
 assert.deepEqual(calls,[{dataset:'clients',id:'demo-client'}]);
 assert.equal(context.vendors[0].record_id,'demo-vendor');
 assert.equal(contextDrawerSections(context).find(s=>s.title==='Vendors').links[0].href,'/vendors?record=demo-vendor');
});
test('empty or failed context hides empty sections',async()=>{
 const context=await loadDealContext({getPartyRecord:async()=>{throw Error('offline');}},{deal:{client_id:'demo-client'}});
 assert.deepEqual(contextDrawerSections(context),[]);
});
test('lost deals never count as closed successes or appear on the board',()=>{
 const rows=[{id:'won',phase:'Closed',outcome:'won'},{id:'lost',phase:'On Deck',outcome:'lost'},{id:'unknown',phase:'Closed'},{id:'open',phase:'Legal'}];
 assert.deepEqual(closedDeals(rows).map(d=>d.id),['won']);
 assert.deepEqual(lostDeals(rows).map(d=>d.id),['lost']);
 assert.deepEqual(localDeals(rows).map(d=>d.id),['open']);
});
test('the current recorded status stays in the feed when the Update composer is empty',async()=>{
 const {createLiveClient}=await import('../js/live-client.js');
 const client=createLiveClient({fetchImpl:async()=>new Response(JSON.stringify({result:{content:[{text:JSON.stringify({deal_id:'demo',name:'Demo',next_step:'Recorded status',thread:[{id:'n',kind:'next_step',text:'Recorded status',actor:'joe',created_at:'2026-10-01T15:00:00Z'}]})}]}}),{status:200})});
 const detail=await client.getDeal('demo');assert.equal(detail.thread.length,1);assert.equal(detail.thread[0].text,'Recorded status');
});
