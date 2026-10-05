import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureClient } from '../js/fixture-client.js';
import { createInvoiceFixture, invoiceTrackerFixture } from '../js/invoice-tracker-fixture.js';
import { relationshipNetworkFixture } from '../js/relationship-network-fixture.js';
import { leaseRadarFixture } from '../js/lease-radar-fixture.js';
import { workspace as leadWorkspace, detail as leadDetail, id as leadId } from '../test/leads-workspace-fixture.mjs';
import { directoryFixture } from '../test/fixtures/vendor-directory.synthetic.mjs';
import { parseViewState, PAGE_SIZE } from '../js/workspace-business-model.js';
import { censusResponse } from './work-inventory-fixture.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const cookieName = 'doctorcre_qa';
const now = () => new Date().toISOString();
const phases = ['pending','research','site_selection','negotiation','legal','due_diligence','closing'];
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
const json = (body, status=200, headers={}) => new Response(JSON.stringify(body), { status, headers:{ 'content-type':'application/json', 'cache-control':'no-store', ...headers } });
const refusal = code => { throw Object.assign(new Error(code), { payload:{error:code} }); };
const namespaceValid = name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name);

function directoryRead(url, state, viewer, namespace) {
  const match=url.pathname.match(/^\/api\/v1\/business\/(clients|vendors)(?:\/([^/]+))?$/);
  if(!match)return null;
  const [,dataset,id]=match;
  const fixtureUrl=new URL(`/api/v1/business/${dataset}`,url);
  const all=state.variant==='empty'?[]:Array.from({length:3},(_,i)=>directoryFixture(`${fixtureUrl}?page=${i+1}`).rows).flat();
  if(id) {
    if(!all.some(row=>row.id===id))return json({error:'record_not_found'},404);
    const payload=directoryFixture(url.href);
    payload.viewer=viewer;payload.record.owned_by_viewer=payload.record.owner_label.toLowerCase()===viewer;
    payload.source.correlation_id=`synthetic-${namespace}-${dataset}`;
    return json(payload);
  }
  const {query}=parseViewState(`/${dataset}`,url.search);
  const payload=directoryFixture(url.href);
  let rows=all.filter(row=>(query.scope!=='mine'||row.owner_label.toLowerCase()===viewer)
    &&(query.owner==='all'||row.owner_label.toLowerCase()===query.owner)
    &&(!query.q||row.name.toLowerCase().includes(query.q.toLowerCase()))
    &&(!query.territory||row.territory===query.territory)
    &&(dataset==='clients'
      ?(!query.status||row.recorded_status===query.status)&&(!query.type||row.recorded_client_type===query.type)
        &&(query.pipeline==='any'||(query.pipeline==='active'?row.recorded_status_active_pipeline===true:query.pipeline==='other'?row.recorded_status_active_pipeline===false:row.recorded_status_active_pipeline==null))
      :(!query.category||row.recorded_category===query.category)&&(!query.stage||row.recorded_stage===query.stage)&&(!query.disposition||row.recorded_disposition===query.disposition)));
  const sortField=query.sort==='recent'?'updated_at':query.sort.startsWith('last_deal')?'last_deal_at':query.sort;
  const descending=query.sort==='recent'||query.sort==='last_deal_desc';
  rows.sort((a,b)=>(descending?-1:1)*String(a[sortField]||'').localeCompare(String(b[sortField]||''))||a.name.localeCompare(b.name));
  payload.viewer=viewer;payload.total=rows.length;payload.page_count=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));payload.out_of_range=query.page>payload.page_count;
  payload.rows=rows.slice((query.page-1)*PAGE_SIZE,query.page*PAGE_SIZE).map(row=>({...row,owned_by_viewer:row.owner_label.toLowerCase()===viewer}));
  payload.facets=dataset==='clients'?{statuses:[{slug:'active',label:'Active'}],types:[{slug:'practice',label:'Practice'}]}:{categories:[{slug:'banker',label:'Banking'},{slug:'architect',label:'Architecture'}],stages:[{slug:'warm',label:'Warm'}],dispositions:[{slug:'active',label:'Active'}],territories:[{slug:'Demo North',label:'Demo North'},{slug:'Demo South',label:'Demo South'}]};
  payload.source.correlation_id=`synthetic-${namespace}-${dataset}`;
  return json(payload);
}

function makeState(variant) {
  const count = variant === 'empty' ? 0 : variant === 'large' ? 160 : 16;
  const today = new Date().toISOString().slice(0,10);
  const deals = Array.from({length:count}, (_, i) => ({ id:`qa-deal-${i+1}`, name:`Demo ${i%2 ? 'Dell' : 'Joe'} ${['Dental Relocation','Primary Care Renewal','Ortho Expansion','Surgical Purchase'][i%4]} ${String(i+1).padStart(3,'0')}`, type:['relocation','renewal','expansion','purchase'][i%4], phase:phases[i%phases.length], owner:i%2 ? 'dell':'joe', attention:i<8 || i%5===0, last_touch:today, next_step:`Review synthetic ${i%2 ? 'lease terms':'property shortlist'}`, next_date:today, segment:'Dental', market:['Pensacola','Mobile','Gulf Breeze','Destin'][i%4], lane:'territory', workspace_kind:'team', operating_state:'active', parking_reason:null, parking_note:null, version:1, field_base:{}, invoiced_on:null, client_name:`Demo Practice ${i+1}` }));
  const template = leadWorkspace().leads;
  const leads = Array.from({length:variant==='empty'?0:variant==='large'?180:template.length}, (_, i) => ({ ...structuredClone(template[i%template.length]), id:leadId(i+1), party_id:leadId(i+1000), registry_ref:`L-${i+1}`, name:`Demo Lead ${String(i+1).padStart(3,'0')}`, doctor_name:`Dr. Demo ${i+1}`, owner:i%3===0?'joe':i%3===1?'dell':null, created_at:now(), first_seen_at:now(), score:95-i%70 }));
  const invoiceRows = invoiceTrackerFixture(today).entries;
  const entries = variant==='empty'?[]:variant==='large'?Array.from({length:120},(_,i)=>({...structuredClone(invoiceRows[i%invoiceRows.length]), deal_id:`qa-invoice-deal-${i+1}`,name:`Demo Invoice Practice ${i+1}`,commission_id:invoiceRows[i%invoiceRows.length].commission_id===null?null:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`, owner:i%2?'dell':'joe'})):invoiceRows;
  return { variant, deals, leads, invoices:createInvoiceFixture({entries}), events:[], threads:new Map(), dates:new Map(), idempotency:new Map(), clients:new Map() };
}

export async function createQaServer({ buildRoot=resolve(repository,'dist/site') }={}) {
  const { handleDoctorcreRequest } = await import('../src/worker.js');
  const namespaces = new Map();
  const identities = new Map();
  const seed = JSON.parse(await readFile(resolve(repository,'data/board-seed.json'),'utf8'));
  const stateFor = namespace => {
    if(!namespaces.has(namespace)) namespaces.set(namespace,makeState('realistic'));
    return namespaces.get(namespace);
  };
  const identify = request => {
    const cookie = request.headers.get('cookie')?.split(';').map(part=>part.trim()).find(part=>part.startsWith(`${cookieName}=`));
    return identities.get(cookie?.slice(cookieName.length+1));
  };
  async function fallback(state, viewer) {
    if(!state.clients.has(viewer)) state.clients.set(viewer,await createFixtureClient({selfActor:viewer,seedUrl:`data:application/json,${encodeURIComponent(JSON.stringify(seed))}`}));
    return state.clients.get(viewer);
  }
  async function call(state, viewer, name, args) {
    if(name==='deal-room-board') return {schema_version:'local-deals-board.v1',actor:viewer,deals:structuredClone(state.deals),accounts:[],open_session:null,as_of:now(),last_call_at:null};
    if(name==='get-deal-room') {
      const deal=state.deals.find(row=>row.id===args.deal);if(!deal)refusal('deal_not_found');
      return { ...structuredClone(deal),deal_id:deal.id,schema_version:'deal-timeline.v1',thread:structuredClone(state.threads.get(deal.id)||[]),critical_dates:structuredClone(state.dates.get(deal.id)||[]),events:state.events.filter(row=>row.deal_id===deal.id), next_actions:[{id:`action-${deal.id}`,owner:deal.owner,description:deal.next_step,due_on:deal.next_date,status:'open'}],activities:[],participants:[{role:'lead',name:deal.owner==='joe'?'Joe':'Dell',actor:deal.owner}],premises:[],negotiation_rounds:[],documents:[],lease:null };
    }
    if(name==='read-invoice-tracker') return {...await state.invoices.getInvoiceTracker(),actor:viewer};
    if(name==='record-commission-receipt') return state.invoices.markInvoicePaid(args);
    if(name==='lead-board') return {schema_version:'lead-workspace.v1',generated_at:now(),last_search_at:null,leads:structuredClone(state.leads),detail:args.lead_id?leadDetail(state.leads.find(row=>row.id===args.lead_id)):null};
    if(name==='capture-queue') return {candidates:[]};
    if(name==='presence-lease')return {ok:true};
    // This fixture does not implement CARR's creation/lead-assignment receipts.
    // Seed setup owns new data; a fallback-only write would falsely succeed.
    if(name==='new-deal')refusal('fixture_operation_unavailable');
    const writeNames=['patch-deal-field','set-next-step','add-deal-note','add-critical-date','update-deal','claim-lead','update-lead'];
    if(writeNames.includes(name)) {
      if(!args.idempotency_key)refusal('missing_idempotency_key');
      const fingerprint=JSON.stringify({viewer,name,args});const prior=state.idempotency.get(args.idempotency_key);
      if(prior){if(prior.fingerprint!==fingerprint)refusal('key_reuse');return structuredClone(prior.result);}
      let result;
      if(name==='claim-lead'||name==='update-lead') {
        const lead=state.leads.find(row=>row.id===args.lead||row.registry_ref===args.lead);if(!lead)refusal('lead_not_found');
        if(args.base_version!==lead.base_version)refusal('version_conflict');
        if(name==='claim-lead'){if(lead.owner||lead.stage!=='new')refusal('lead_not_claimable');lead.owner=viewer;}else Object.assign(lead,args.fields);
        lead.base_version++;result={ok:true,base_version:lead.base_version};
      } else {
        const deal=state.deals.find(row=>row.id===args.deal);if(!deal)refusal('deal_not_found');
        if(name==='update-deal'&&args.base_version!==deal.version)refusal('version_conflict');
        const field=name==='set-next-step'?'next_step':args.field;
        if(name==='patch-deal-field'&&(deal.field_base[field]?.event_id||null)!==(args.base_event_id||null))refusal('version_conflict');
        const old_value=field?deal[field]:null;
        if(name==='patch-deal-field')deal[field]=args.value;
        if(name==='set-next-step'){deal.next_step=args.text;if(Object.hasOwn(args,'next_date'))deal.next_date=args.next_date;}
        if(name==='add-deal-note')state.threads.set(deal.id,[{id:`qa-note-${state.events.length+1}`,kind:'note',actor:viewer,text:args.text,recorded_at:now()},...(state.threads.get(deal.id)||[])]);
        if(name==='add-critical-date')state.dates.set(deal.id,[...(state.dates.get(deal.id)||[]),{id:`qa-date-${state.events.length+1}`,kind:args.kind,due_on:args.due_on,source:args.source}]);
        if(name==='update-deal')Object.assign(deal,args.fields);
        deal.version++;
        const event={id:`qa-event-${state.events.length+1}`,deal_id:deal.id,actor:viewer,field:field||null,old_value,new_value:field?deal[field]:args.text,recorded_at:now(),verb:name};state.events.push(event);
        if(field)deal.field_base[field]={event_id:event.id,recorded_at:event.recorded_at};
        result={ok:true,event_id:event.id,event_recorded_at:event.recorded_at,version:deal.version,event};
      }
      state.idempotency.set(args.idempotency_key,{fingerprint,result});return result;
    }
    const client=await fallback(state,viewer);
    const overrides={'read-session-identity':'sessionIdentity','read-dispatch-history':'dispatchHistory','read-room':'roomTurns','read-room-queue':'roomQueue','read-notification-preferences':'notificationPreferences','read-doc-outcome-cards':'docOutcomeCards','list-my-codex-sessions':'codexSessions','start-deal-review':'startReview','end-deal-review':'endReview','review-deal':'reviewDeal'};
    const method=overrides[name]||name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
    if(typeof client[method]!=='function')refusal('fixture_operation_unavailable');
    return client[method](args);
  }
  async function carr(request) {
    const url=new URL(request.url);const identity=identify(request);
    if(url.pathname==='/auth/logout')return new Response(null,{status:302,headers:{location:'/auth/login','set-cookie':`${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`}});
    if(url.pathname==='/auth/login')return new Response('<!doctype html><title>Fixture sign in</title><h1>Fixture sign in required</h1><p>Synthetic identities are created by the QA setup fixture.</p>',{headers:{'content-type':'text/html'}});
    if(!identity)return url.pathname==='/mcp'||url.pathname.startsWith('/api/')||url.pathname==='/pipeline/changes'?json({error:'not_authenticated'},401):new Response(null,{status:302,headers:{location:`/auth/login?return_to=${encodeURIComponent(url.pathname+url.search)}`}});
    const {viewer,namespace}=identity;const state=stateFor(namespace);
    if(url.pathname==='/mcp') {
      let input;try{input=await request.json();}catch{return json({error:'invalid_json'},400);}
      if(input.method!=='tools/call')return json({jsonrpc:'2.0',id:input.id,error:{code:-32601,message:'Method not found'}});
      try{return json({jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:JSON.stringify(await call(state,viewer,input.params.name,input.params.arguments||{}))}]}});}
      catch(error){return json({jsonrpc:'2.0',id:input.id,result:{isError:true,content:[{type:'text',text:JSON.stringify(error.payload||{error:error.message})}]}});}
    }
    if(url.pathname==='/pipeline/changes')return json({events:state.events.filter(row=>Number(row.id.split('-').at(-1))>Number(url.searchParams.get('cursor')||0)),cursor:String(state.events.length),presence:[]});
    if(url.pathname==='/api/v1/work-inventory') {
      if(request.method!=='GET')return json({error:'fixture_method_unavailable'},405);
      const projection=censusResponse(url);projection.viewer=viewer;projection.source.correlation_id=`${namespace}-${projection.source.correlation_id}`;
      return json(projection);
    }
    if(url.pathname==='/api/system-work/current')return request.method==='GET'?json({ok:true,data:await (await fallback(state,viewer)).currentWorkRequests()}):json({error:'fixture_method_unavailable'},405);
    const directory=directoryRead(url,state,viewer,namespace);
    if(directory)return request.method==='GET'?directory:json({error:'fixture_method_unavailable'},405);
    if(url.pathname==='/api/v1/business/relationships')return json(relationshipNetworkFixture());
    if(url.pathname==='/api/v1/business/leases')return json(leaseRadarFixture());
    if(url.pathname==='/api/v1/command-center'){
      const projection=await (await fallback(state,viewer)).commandCenter();
      for(const metric of projection.metrics){const rows=state.deals.filter(row=>metric.scope==='team'||row.owner===viewer);metric.active_deals=rows.length;metric.flagged_deals=rows.filter(row=>row.attention).length;}
      for(const need of projection.needs_you_now){if(need.kind==='team_flagged_deals')need.count=state.deals.filter(row=>row.attention).length;if(need.kind==='my_flagged_deals')need.count=state.deals.filter(row=>row.owner===viewer&&row.attention).length;}
      return json(projection);
    }
    if(url.pathname.startsWith('/api/'))return json({error:'fixture_endpoint_unavailable'},404);
    return new Response(null,{status:200});
  }
  async function assets(request) {
    const path=resolve(buildRoot,`.${new URL(request.url).pathname}`);const rel=relative(buildRoot,path);
    if(rel.startsWith('..')||isAbsolute(rel))return new Response('Not found',{status:404});
    try{if(!(await stat(path)).isFile())return new Response('Not found',{status:404});return new Response(request.method==='HEAD'?null:await readFile(path),{headers:{'content-type':mime[extname(path)]||'application/octet-stream'}});}catch{return new Response('Not found',{status:404});}
  }
  async function dispatch(request) {
    const url=new URL(request.url);
    // Share deploys separately in production. Mount its unmodified build here
    // so fixture QA cannot follow the app Worker's live reports redirect.
    const shareAsset=url.pathname==='/share'?'/reports/share.html'
      :['/share.css','/share-bootstrap.js','/share.js'].includes(url.pathname)||url.pathname.startsWith('/vendor/maplibre-gl-6.4.1/')?`/reports${url.pathname}`:null;
    if(shareAsset) {
      if(!['GET','HEAD'].includes(request.method))return json({error:'fixture_method_unavailable'},405);
      const assetUrl=new URL(url);assetUrl.pathname=shareAsset;assetUrl.search='';
      const response=await assets(new Request(assetUrl,request));
      const headers=new Headers(response.headers);
      headers.set('content-security-policy',"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
      headers.set('cache-control','no-store');
      return new Response(response.body,{status:response.status,headers});
    }
    if(url.pathname.startsWith('/api/share/'))return json({error:'fixture_endpoint_unavailable'},404);
    if(url.pathname==='/api/test/health')return json({ok:true,synthetic:true});
    if(url.pathname==='/api/test/seed'&&request.method==='POST') {
      const {namespace,variant='realistic',viewer='joe',reset=false}=await request.json();
      if(!namespaceValid(namespace)||!['empty','large','realistic'].includes(variant)||!['joe','dell'].includes(viewer))return json({error:'invalid_fixture_request'},400);
      if(reset||!namespaces.has(namespace)||stateFor(namespace).variant!==variant)namespaces.set(namespace,makeState(variant));
      const value=`fixture.${namespace}.${viewer}`;identities.set(value,{namespace,viewer});const state=stateFor(namespace);
      return json({synthetic:true,namespace,viewer,variant,counts:{deals:state.deals.length,leads:state.leads.length,invoices:(await state.invoices.getInvoiceTracker()).entries.length},cookie:{name:cookieName,value,url:url.origin,httpOnly:true,sameSite:'Lax'}},200,{'set-cookie':`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax`});
    }
    if(url.pathname==='/api/test/identity')return identify(request)?json({synthetic:true,...identify(request)}):json({error:'not_authenticated'},401);
    return handleDoctorcreRequest(request,{ASSETS:{fetch:assets},CARR:{fetch:carr},APP_ENV:'fixture',GIT_SHA:'0'.repeat(40)});
  }
  const server=createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const origin=new URL('http://127.0.0.1');origin.port=String(server.address().port);
      const request=new Request(new URL(req.url,origin),{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks),duplex:'half'}:{})});
      const response=await dispatch(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'fixture_server_error',message:error.message}));}
  });
  return {server,dispatch};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {server}=await createQaServer({buildRoot:process.env.QA_BUILD_ROOT||resolve(repository,'dist/site')});
  server.listen(Number(process.env.PORT||18997),'127.0.0.1',()=>console.log(`Synthetic DoctorCRE QA server http://127.0.0.1:${server.address().port}`));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
