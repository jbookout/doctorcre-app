import { LIST_ROW_KEYS, RECORD_KEYS, parseViewState, PAGE_SIZE } from '../../js/workspace-business-model.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tileMix=(total,open_deal,past_client)=>({total,open_deal,past_client,no_deal_yet:total-open_deal-past_client});
// Made-up counts for the tiles Clients opens on.
// A client's status cycles so each status chip has rows; an open deal names the client.
const CLIENT_STATUSES=[['active_deal','Active deal'],['past_client','Past client'],['roster','Roster']];
const CLIENT_TILES={all:tileMix(3,1,1),national_accounts:{accounts:0,...tileMix(0,0,0)},practice_types:[{practice_type:'Dental',...tileMix(2,1,1)}],not_set:tileMix(1,0,0)};

export function directoryFixture(url, { now = Date.now(), overrides = new Map() } = {}) {
  const u = new URL(url), path = u.pathname.replace('/api/v1/business', '');
  const dataset = path.split('/')[1], recordId = path.split('/')[2];
  const source = { source: dataset === 'vendors' ? 'vendor' : 'client', source_ref: 'synthetic', observed_at: new Date(now).toISOString(), valid_until: new Date(now+60000).toISOString(), freshness: 'fresh', correlation_id: 'synthetic-directory', safe_explanation: 'Synthetic fixture' };
  const records = Array.from({length:62},(_,n)=>({
    ...Object.fromEntries(RECORD_KEYS[dataset].map(key=>[key,null])),
    id:id(n+1), ref:`${dataset==='vendors'?'V':'C'}-DEMO-${n+1}`, name:`Demo ${dataset==='vendors'?'Partner':'Practice'} ${String(n+1).padStart(2,'0')}`, party_kind:'org', city:'Demo City', state:'FL', owner_label:n%2?'Dell':'Joe', owned_by_viewer:n%2===0, record_version:overrides.has(id(n+1))?2:1, created_at:'2022-01-01T00:00:00Z', updated_at:'2026-10-01T12:00:00Z',
    recorded_status:dataset==='clients'?CLIENT_STATUSES[n%3][0]:'active', recorded_status_label:dataset==='clients'?CLIENT_STATUSES[n%3][1]:'Active', recorded_status_active_pipeline:true, recorded_client_type:'practice', recorded_client_type_label:'Practice', vertical:n%2?'Dental':'Primary care', deal_type:n%2?'Purchase':'Lease', deal_type_label:n%2?'Purchase':'Lease', last_deal_at:`2026-09-${String(n%28+1).padStart(2,'0')}T00:00:00Z`, notes:'Discussed the upcoming assignment.\nOriginal synthetic entry with more details.',
    recorded_category:n%2?'architect':'banker', recorded_category_label:n%2?'Architecture':'Banking', recorded_stage:'warm', recorded_stage_label:'Warm', recorded_disposition:n%11===7?'avoid':n%13===5?'parked':'active', recorded_disposition_label:n%11===7?'Avoid':n%13===5?'Parked':'Active', relationship_level:[3,2,1,0,null][n%5], relationship_level_label:['Core','Established','Building','Prospective',null][n%5], is_target:n%6===2, verticals:[n%2?'Dental':'Primary care'], territory:n%2?'Demo North':'Demo South', offers:'Practice finance and equipment loans.\nSynthetic service description.', loan_programs:n%2?[]:['Practice acquisition','Equipment finance','Owner-occupied real estate'],
    relationship:{coverage_verified_at:source.observed_at,deals_referred:12,deals_worked:10,won:8,lost:2,win_rate:.8,first_worked_at:'2022-01-01T00:00:00Z',last_contacted_at:'2026-09-30T16:30:00Z',last_contact_note:'Discussed financing for a new office.',computed_tier:n%3===0?'Proven':n%3===1?'Established':'Trial',formula_version:'vendor-trust.v1',override:overrides.get(id(n+1))||null,
    introductions:[{id:'demo-intro',kind:'introduced',from_name:'Demo Partner A',to_name:'Demo Practice B',note:'Practice financing introduction.\nOriginal synthetic introduction entry with the recorded conversation.',occurred_at:'2026-09-23',via_party:null},{id:'demo-suggestion',kind:'can_introduce',from_name:'Demo Partner C',to_name:'Demo Practice D',note:'Shared dental focus.',occurred_at:null,via_party:null}],recent_entries:[{id:'demo-entry',kind:'email_in',when:'2026-09-30T16:30:00Z',summary:'Discussed financing for a new office.',detail:'Original synthetic email: We discussed the new office and the equipment financing options.'}]}
  }));
  if(path==='/vendors/summary') return vendorSummary(records,u.searchParams.get('owner'));
  const allowed=(row,keys,optional)=>Object.fromEntries([...keys,...optional].map(key=>[key,row[key]??null]));
  const optional=dataset==='vendors'?['relationship','vertical','deal_type','last_deal_at','territory','categories','quiet','quiet_days']:['deal_type','last_deal_at','active_deals'];
  if(dataset==='clients') for(const row of records) row.active_deals=row.recorded_status==='active_deal'?[{id:row.id,name:`New office ${row.ref}`}]:[];
  for(const [n,row] of records.entries()) Object.assign(row,{categories:row.recorded_category?[{slug:row.recorded_category,label:row.recorded_category_label}]:[],quiet:n%4===0,quiet_days:n%4===0?90+n:null});
  if(recordId){
    const row=records.find(row=>row.id===recordId);
    const record=allowed(row,RECORD_KEYS[dataset],dataset==='vendors'?['relationship','loan_programs']:['deal_type','last_deal_at']);
    if(dataset==='vendors' && u.searchParams.get('contract')==='vendor-directory.v2') {
      const office={street_address:'1 Demo Plaza',city:'Demo Office City',state:'FL',finding_id:id(9001),source:'Synthetic office evidence',observed_at:'2026-10-01T12:00:00Z',expires_on:null};
      record.people=['Alpha','Beta','Gamma'].map((name,n)=>({
        company:{id:row.id,name:row.name},contact:{id:id(1000+Number(recordId.slice(-4))*3+n),name:`Demo Contact ${name}`,email:null,phone:null,cell:null},
        office:n===0?office:null,
        research:n===0?{status:'office_verified',finding_id:office.finding_id,observed_at:office.observed_at,expires_on:null}:n===1?{status:'needs_review',finding_id:id(9002),observed_at:office.observed_at,expires_on:null}:{status:'not_researched',finding_id:null,observed_at:null,expires_on:null},
      }));
    }
    return {viewer:'joe',dataset,record,partial:null,not_in_this_read:[],recorded_field_note:'Synthetic',source};
  }
  const parsed=parseViewState('/'+dataset,u.search), {all,no_category,market,relationship:_,...asked}=parsed.query, query={...asked,...(no_category&&{no_category:true}),...(asked.quiet&&{quiet:true}),q:parsed.query.q||null,page_size:PAGE_SIZE};
  for(const key of ['category','stage','disposition','status','territory']) if(key in query && !query[key]) query[key]=null;
  // Like the engine, the tile filters echo only when sent, and the app's own key never travels.
  for(const key of ['practice_type','national_account']) if(u.searchParams.has(key)) query[key]=u.searchParams.get(key); else delete query[key];
  delete query.not_set;
  let filtered=records.filter(row=>(!query.q||row.name.toLowerCase().includes(query.q.toLowerCase()))&&(query.owner==='all'||row.owner_label.toLowerCase()===query.owner)&&(!query.territory||row.territory===query.territory)&&(!query.category||row.recorded_category===query.category)&&(!query.no_category||row.recorded_category===null)&&(!query.quiet||row.quiet)&&(!query.status||(query.status==='no_deal_yet'?!['active_deal','past_client'].includes(row.recorded_status):row.recorded_status===query.status)));
  const rank=row=>row.recorded_disposition==='avoid'?6:row.recorded_disposition==='parked'?5:row.relationship_level===null?4:3-row.relationship_level;
  filtered.sort((a,b)=>query.sort==='last_deal_desc'?b.last_deal_at.localeCompare(a.last_deal_at):query.sort==='last_deal_asc'?a.last_deal_at.localeCompare(b.last_deal_at):query.sort==='status'?a.recorded_status.localeCompare(b.recorded_status)||a.name.localeCompare(b.name):query.sort==='owner'?a.owner_label.localeCompare(b.owner_label)||a.name.localeCompare(b.name):['vertical','deal_type','territory'].includes(query.sort)?a[query.sort].localeCompare(b[query.sort])||a.name.localeCompare(b.name):query.sort==='relationship'?rank(a)-rank(b)||a.name.localeCompare(b.name):a.name.localeCompare(b.name));
  // Like the engine, a vendor category answers every vendor in one page.
  const size=dataset==='vendors'&&(query.category||query.no_category||u.searchParams.get('markets')==='true')?Math.max(filtered.length,1):PAGE_SIZE;
  const tiles=dataset==='clients'&&u.searchParams.get('tiles')==='true'?{tiles:CLIENT_TILES}:{};
  return {...tiles,viewer:'joe',dataset,query,total:filtered.length,page:query.page,page_size:size,page_count:Math.max(1,Math.ceil(filtered.length/size)),out_of_range:query.page>Math.max(1,Math.ceil(filtered.length/size)),rows:filtered.slice((query.page-1)*size,query.page*size).map(row=>allowed(row,LIST_ROW_KEYS[dataset],optional)),facets:dataset==='vendors'?{categories:[{slug:'banker',label:'Banking'}],stages:[],dispositions:[],territories:[{slug:'Demo North',label:'Demo North'},{slug:'Demo South',label:'Demo South'}]}:{statuses:[{slug:'active',label:'Active'}],types:[]},partial:null,recorded_field_note:'Synthetic',source};
}

// The engine's category tiles over the same made-up vendors.
function vendorSummary(records,owner){
  const words=['core','established','building','prospective','not_rated','parked','avoid'];
  const vendors=records.filter(row=>!owner||row.owner_label.toLowerCase()===owner);
  const counts=rows=>({count:rows.length,quiet:rows.filter((_,n)=>n%4===0).length,relationship:Object.fromEntries(words.map(word=>[word,rows.filter(row=>(row.recorded_disposition==='avoid'?'avoid':row.recorded_disposition==='parked'?'parked':['prospective','building','established','core'][row.relationship_level]??'not_rated')===word).length]))});
  return {all:counts(vendors),no_category:counts(vendors.filter(row=>row.recorded_category===null)),categories:[{slug:'architect',label:'Architecture'},{slug:'attorney',label:'Attorney'},{slug:'banker',label:'Banking'}].map(c=>({...c,...counts(vendors.filter(row=>row.recorded_category===c.slug))}))};
}
