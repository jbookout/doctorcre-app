import test from 'node:test';
import assert from 'node:assert/strict';
import { localDeals, needsAttention, urgencyOrder, automaticMove, noteEntries, PHASE_TRIGGERS } from '../js/local-deals-model.js';
const base={id:'demo-1',name:'Demo One',phase:'Research',owner:'joe',next_step:'Confirm tour',last_touch:'2026-10-01',last_review_at:'2026-10-01T16:00:00Z'};
const now=Date.parse('2026-10-01T17:00:00Z');
test('local scope excludes national and invoiced assignments and filters only owner',() => {
  const rows=[base,{...base,id:'national',workspace_kind:'national_account'},{...base,id:'parent',account_client_id:'demo-account'},{...base,id:'invoice',invoiced_on:'2026-10-01'},{...base,id:'dell',owner:'dell'}];
  assert.deepEqual(localDeals(rows).map(d=>d.id),['demo-1','dell']); assert.deepEqual(localDeals(rows,'joe').map(d=>d.id),['demo-1']);
});
test('every requested attention condition ranks before the rest; parked never requests attention',() => {
  for(const fields of [{attention:true},{needs_attention:true},{flagged:true},{missing_step:true},{changed_since_review:true},{gone_quiet:true},{next_step:''},{last_touch:'2026-09-01'},{phase_change:{recorded_at:'2026-10-01T17:00:00Z'}}]) {
    const d={...base,id:'urgent',...fields};assert.equal(needsAttention(d,now),true);assert.equal(urgencyOrder([base,d],now)[0].id,'urgent');assert.equal(needsAttention({...d,operating_state:'parked'},now),false);
  }
  assert.equal(needsAttention(base,now),false);
});
test('automatic move and invoice close name only dated evidence with an exact undo target',() => {
 const change={event_id:'event-1',prior_phase:'research',phase:'negotiation',automatic:true,reason:'LOI sent',evidence_date:'2026-10-03'};
 assert.deepEqual(automaticMove({...base,phase_change:change}),{eventId:'event-1',text:'Moved by Doc: LOI sent 10/3'});
 assert.equal(automaticMove({...base,phase:'Closed',phase_change:{...change,phase:'closed',reason:'invoice'}}).text,'Closed by Doc: invoice 10/3');
 for(const field of ['event_id','prior_phase','evidence_date']) assert.equal(automaticMove({...base,phase_change:{...change,[field]:null}}),null);
 assert.equal(automaticMove({...base,phase_change:{...change,automatic:false}}),null);
 assert.equal(automaticMove({...base,phase_change:{...change,reason:null}}).text,'Moved by Doc: phase changed 10/3');
});
test('notes summarize but retain original entry, including hostile text as data',() => {
 const original='Demo email <script>never execute</script> '+ 'Detailed clause. '.repeat(40);
 const entries=noteEntries({activities:[{id:'a',kind:'email',summary:'LOI submitted',detail:original,occurred_at:'2026-10-01'}],thread:[]});
 assert.equal(entries[0].summary,'LOI submitted');assert.equal(entries[0].original,original);
 assert.equal(PHASE_TRIGGERS.closing,'Due-diligence deadline passed');
});


test('W4 read binds the separate producer revision and versioned phase/parking fields', async () => {
 const {readFile} = await import('node:fs/promises');
 const contract = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1.json',import.meta.url),'utf8')).mcp_read_contracts['deal-room-board'];
 assert.equal(contract.producer.source_commit,'7214532128a836a84d3e75a584e56facbf6662ba');
 assert.equal(contract.response.schema_version,'local-deals-board.v1');
 for(const key of ['operating_state','parking_note','phase_change','invoiced_on']) assert.ok(contract.response.deal_keys.includes(key));
});
