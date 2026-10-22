import test from 'node:test';
import assert from 'node:assert/strict';
import { localDeals, needsAttention } from '../js/deal-review-model.js';
import { urgencyOrder, automaticMove, noteEntries, PHASE_TRIGGERS } from '../js/local-deals-model.js';
const base={id:'demo-1',name:'Demo One',phase:'Research',owner:'joe',next_step:'Confirm tour',last_touch:'2026-10-01',last_review_at:'2026-10-01T16:00:00Z'};
const now=Date.parse('2026-10-01T17:00:00Z');
test('local scope excludes national and invoiced assignments and filters only owner',() => {
  const rows=[base,{...base,id:'national',workspace_kind:'national_account'},{...base,id:'parent',account_client_id:'demo-account'},{...base,id:'invoice',invoiced_on:'2026-10-01'},{...base,id:'dell',owner:'dell'}];
  assert.deepEqual(localDeals(rows).map(d=>d.id),['demo-1','dell']); assert.deepEqual(localDeals(rows,'joe').map(d=>d.id),['demo-1']);
});
test('only a recorded overdue next step requests attention; flags and edits alone do not', () => {
  for (const fields of [{attention:true},{needs_attention:true},{flagged:true},{missing_step:true},{changed_since_review:true},{gone_quiet:true},{next_step:''},{last_touch:'2026-09-01'},{phase_change:{recorded_at:'2026-10-01T17:00:00Z'}},{next_date:'2026-10-01'},{next_date:'2026-02-30'}])
    assert.equal(needsAttention({...base,...fields},now),false);
  const overdue={...base,id:'overdue',next_date:'2026-09-30'};
  assert.equal(needsAttention(overdue,now),true);
  assert.equal(urgencyOrder([base,overdue],now)[0].id,'overdue');
  for(const fields of [{operating_state:'parked'},{phase:'closed'},{outcome:'lost'},{invoiced_on:'2026-10-01'},{next_step:''}])
    assert.equal(needsAttention({...overdue,...fields},now),false);
});
test('overdue uses the Chicago business day across browser timezones', () => {
  const midnightInParis=Date.parse('2026-10-02T00:30:00Z');
  assert.equal(needsAttention({...base,next_date:'2026-10-01'},midnightInParis),false);
  assert.equal(needsAttention({...base,next_date:'2026-09-30'},midnightInParis),true);
});
test('automatic move and invoice close name only dated evidence with an exact undo target',() => {
 const change={event_id:'event-1',prior_phase:'research',phase:'negotiation',automatic:true,reason:'LOI sent',evidence_date:'2026-10-03'};
 assert.deepEqual(automaticMove({...base,phase_change:change}),{eventId:'event-1',text:'Moved automatically: LOI sent 10/3'});
 assert.equal(automaticMove({...base,phase:'Closed',phase_change:{...change,phase:'closed',reason:'invoice'}}).text,'Closed automatically: invoice 10/3');
 for(const field of ['event_id','prior_phase','evidence_date']) assert.equal(automaticMove({...base,phase_change:{...change,[field]:null}}),null);
 assert.equal(automaticMove({...base,phase_change:{...change,automatic:false}}),null);
 assert.equal(automaticMove({...base,phase_change:{...change,reason:null}}).text,'Moved automatically: phase changed 10/3');
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
 assert.equal(contract.producer.source_commit,'f011675bb94f9c02fd721dd94a01cc6f52ea4762');
 assert.equal(contract.response.schema_version,'local-deals-board.v1');
 for(const key of ['operating_state','parking_note','phase_change','invoiced_on','phase_started_on','vendors','prospect_engagement_status','client_version']) assert.ok(contract.response.deal_keys.includes(key));
});

test('open local deals omit closed phases, terminal outcomes and invoices, including parked closures', () => {
 const rows=[base,{...base,id:'closed',phase:'Closed'},{...base,id:'closed-slug',phase:'closed',operating_state:'parked'},{...base,id:'won',outcome:'won'},{...base,id:'paused',outcome:'paused'},{...base,id:'invoiced',invoiced_on:'2026-10-01'}];
 assert.deepEqual(localDeals(rows).map(d=>d.id),['demo-1']);
});

test('only active prospective clients remain on the deal board in every phase', () => {
 const prospect={...base,client_status:'prospect',prospect_engagement_status:'active'};
 const rows=[prospect,{...prospect,id:'inactive',prospect_engagement_status:'inactive'},
  {...prospect,id:'inactive-research',phase:'Research',prospect_engagement_status:'inactive'},
  {...prospect,id:'unknown',prospect_engagement_status:null},
  {...base,id:'client',client_status:'active',prospect_engagement_status:'inactive'}];
 assert.deepEqual(localDeals(rows).map(d=>d.id),['demo-1','client']);
});

test('active backfilled and newly created prospects retain board membership, including parked deals', () => {
 const rows=['On Deck','Research','Negotiation','Legal','Closing'].flatMap((phase,index)=>[
  {...base,id:`existing-${index}`,phase,client_status:'prospect',prospect_engagement_status:'active'},
  {...base,id:`parked-${index}`,phase,client_status:'prospect',prospect_engagement_status:'active',operating_state:'parked'}
 ]);
 rows.push({...base,id:'new-prospect',phase:'On Deck',client_status:'prospect',prospect_engagement_status:'active'});
 assert.deepEqual(localDeals(rows).map(d=>d.id),rows.map(d=>d.id));
 const explicitlyInactive=rows.map(d=>d.id==='existing-0'?{...d,prospect_engagement_status:'inactive'}:d);
 assert.deepEqual(localDeals(explicitlyInactive).map(d=>d.id),rows.slice(1).map(d=>d.id));
});
