import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { createLiveClient } from '../js/live-client.js';
import { validListPayload, validRecordPayload, echoesQuery, parseViewState } from '../js/workspace-business-model.js';
import { validInvoiceTracker } from '../js/invoice-tracker-model.js';
import { validWorkInventoryPayload } from '../js/work-inventory-model.js';
import { validCurrentWorkRequestsPayload, validIncidentBoardPayload, validCurrentWorkItemPayload } from '../js/control-room-model.js';

const artifactDir=await mkdtemp(join(tmpdir(),'doctorcre-qa-fixture-artifact-'));
await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:artifactDir,commit:'1'.repeat(40)});
const buildRoot=join(artifactDir,'site');

test('built static app crosses its live seam with isolated synthetic accounts and shared partner writes', async () => {
  const { dispatch } = await createQaServer({buildRoot});
  const origin = 'http://127.0.0.1:18997';
  const request = (path, init={}) => dispatch(new Request(new URL(path, origin), init));
  const seed = async (namespace, viewer, variant='realistic') => (await request('/api/test/seed', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({namespace,viewer,variant})})).json();
  assert.equal((await request('/mcp', {method:'POST',body:'{}'})).status,401);
  assert.equal((await request('/deals?mode=live')).status,302);
  const joe=await seed('selftest','joe');const dell=await seed('selftest','dell');const isolated=await seed('isolated','joe');
  const caller = identity => (path, init={}) => request(path, {...init,headers:{...init.headers,cookie:`${identity.cookie.name}=${identity.cookie.value}`}});
  const joeClient=createLiveClient({fetchImpl:caller(joe),docContext:false});
  const dellClient=createLiveClient({fetchImpl:caller(dell),docContext:false});
  assert.equal((await joeClient.getBoard()).actor,'joe');assert.equal((await dellClient.getBoard()).actor,'dell');
  const page=await caller(joe)('/?mode=live');assert.equal(page.status,200);
  assert.equal(await page.text(),await readFile(join(buildRoot,'workspace.html'),'utf8'));
  const args={deal:'qa-deal-1',field:'owner',value:'dell',base_event_id:null,idempotency_key:'synthetic-handoff-key'};
  const first=await joeClient.patchDealField(args);assert.equal(first.ok,true);
  assert.deepEqual(await joeClient.patchDealField(args),first);
  assert.equal((await dellClient.getDeal('qa-deal-1')).deal.owner,'dell');
  assert.equal((await createLiveClient({fetchImpl:caller(isolated),docContext:false}).getDeal('qa-deal-1')).deal.owner,'joe');
  await assert.rejects(()=>joeClient.patchDealField({...args,value:'joe',idempotency_key:'stale-key'}),/version_conflict/);
  const changes=await dellClient.getChanges(null);assert.equal(changes.events.length,1);assert.equal(changes.events[0].actor,'joe');
  await joeClient.addDealNote({deal:'qa-deal-1',text:'Synthetic handoff: Dell reviews the three shortlisted spaces.',idempotency_key:'synthetic-note-key'});
  assert.equal((await dellClient.getDeal('qa-deal-1')).thread[0].text,'Synthetic handoff: Dell reviews the three shortlisted spaces.');
  await joeClient.addCriticalDate({deal:'qa-deal-1',kind:'inspection',due_on:'2026-10-15',source:'Synthetic inspection appointment',idempotency_key:'synthetic-date-key'});
  assert.equal((await dellClient.getDeal('qa-deal-1')).critical_dates[0].date,'2026-10-15');
  const invoices=await dellClient.getInvoiceTracker();const invoice=invoices.entries.find(row=>row.status==='invoiced');
  await dellClient.markInvoicePaid({commission_id:invoice.commission_id,base_version:invoice.base_version,received_on:new Date().toISOString().slice(0,10),idempotency_key:'synthetic-paid-key'});
  assert.equal((await joeClient.getInvoiceTracker()).entries.find(row=>row.commission_id===invoice.commission_id).status,'received');
  const empty=await seed('empty','joe','empty');const emptyClient=createLiveClient({fetchImpl:caller(empty),docContext:false});assert.equal((await emptyClient.getBoard()).deals.length,0);assert.equal(validInvoiceTracker(await emptyClient.getInvoiceTracker()),true);
  const large=await seed('large','joe','large');const largeClient=createLiveClient({fetchImpl:caller(large),docContext:false});assert.equal((await largeClient.getBoard()).deals.length,160);
  const largeInvoices=await largeClient.getInvoiceTracker();assert.equal(validInvoiceTracker(largeInvoices),true);assert.equal(largeInvoices.entries.length,120);
  const control=await (await caller(large)('/api/v1/command-center')).json();assert.equal(control.metrics.find(row=>row.scope==='team').active_deals,160);
});

test('synthetic directory honors the pinned list/detail contract, identity, pagination and filters', async () => {
  const {dispatch}=await createQaServer({buildRoot});
  const origin='http://127.0.0.1:18998';
  const seed=async(viewer,variant='realistic')=>(await dispatch(new Request(`${origin}/api/test/seed`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({namespace:`directory-${variant}`,viewer,variant})}))).json();
  const joe=await seed('joe'),dell=await seed('dell');
  const read=(identity,path)=>dispatch(new Request(new URL(path,origin),{headers:{cookie:`${identity.cookie.name}=${identity.cookie.value}`}}));
  assert.equal((await dispatch(new Request(`${origin}/api/v1/business/clients`))).status,401);
  for(const dataset of ['clients','vendors']) {
    const team=await (await read(joe,`/api/v1/business/${dataset}?contract=vendor-directory.v1`)).json();
    assert.equal(validListPayload(team,dataset),true);assert.equal(team.total,62);assert.equal(team.rows.length,25);
    const second=await (await read(joe,`/api/v1/business/${dataset}?page=2`)).json();
    assert.equal(second.page,2);assert.equal(second.rows.length,25);assert.equal(new Set([...team.rows,...second.rows].map(row=>row.id)).size,50);
    const minePath=`/api/v1/business/${dataset}?scope=mine&owner=dell`;
    const mine=await (await read(dell,minePath)).json();
    assert.equal(validListPayload(mine,dataset),true);assert.equal(echoesQuery(mine,parseViewState(`/${dataset}`,'?scope=mine&owner=dell').query),true);
    assert.equal(mine.viewer,'dell');assert.equal(mine.total,31);assert.equal(mine.rows.every(row=>row.owned_by_viewer&&row.owner_label==='Dell'),true);
    const contradictory=await (await read(joe,minePath)).json();assert.equal(contradictory.total,0);
    const row=team.rows[0];const record=await (await read(dell,`/api/v1/business/${dataset}/${row.id}`)).json();
    assert.equal(validRecordPayload(record,dataset,row.id),true);assert.equal(record.viewer,'dell');assert.equal(record.record.name,row.name);assert.equal(record.record.owned_by_viewer,false);
    const searched=await (await read(joe,`/api/v1/business/${dataset}?q=${encodeURIComponent(row.name)}`)).json();assert.equal(searched.total,1);
    assert.equal((await read(joe,`/api/v1/business/${dataset}/not-a-record`)).status,404);
    const empty=await seed('joe','empty');const emptyList=await (await read(empty,`/api/v1/business/${dataset}`)).json();assert.equal(validListPayload(emptyList,dataset),true);assert.equal(emptyList.total,0);
    assert.equal((await read(empty,`/api/v1/business/${dataset}/${row.id}`)).status,404);
  }
});

test('fixture Share mounts exact built page and local dependencies without live redirect or API proxy', async () => {
  const {dispatch}=await createQaServer({buildRoot});
  const origin='http://127.0.0.1:18999';
  const response=await dispatch(new Request(`${origin}/share?qa=synthetic`));
  assert.equal(response.status,200);assert.equal(response.headers.get('location'),null);
  assert.match(response.headers.get('content-security-policy'),/connect-src 'self'/);
  const page=Buffer.from(await response.arrayBuffer());
  assert.deepEqual(page,await readFile(join(buildRoot,'reports/share.html')));
  for(const path of ['/share.css','/share-bootstrap.js','/share.js','/vendor/maplibre-gl-6.4.1/maplibre-gl.css','/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs','/vendor/maplibre-gl-6.4.1/maplibre-gl-shared.mjs','/vendor/maplibre-gl-6.4.1/maplibre-gl-worker.mjs']) {
    const asset=await dispatch(new Request(new URL(path,origin)));
    assert.equal(asset.status,200);assert.equal(asset.headers.get('location'),null);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()),await readFile(join(buildRoot,'reports',path)));
  }
  for(const path of ['/api/share/report','/api/share/map','/api/share/feedback']) {
    const unavailable=await dispatch(new Request(new URL(path,origin)));
    assert.equal(unavailable.status,404);assert.deepEqual(await unavailable.json(),{error:'fixture_endpoint_unavailable'});assert.equal(unavailable.headers.get('location'),null);
  }
  const post=await dispatch(new Request(`${origin}/api/share/exchange`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'synthetic-no-access'})}));
  assert.equal(post.status,404);assert.deepEqual(await post.json(),{error:'fixture_endpoint_unavailable'});
  const head=await dispatch(new Request(`${origin}/share`,{method:'HEAD'}));assert.equal(head.status,200);assert.equal(await head.text(),'');
});

test('All Work and Status load existing synthetic projections through authenticated HTTP and MCP seams', async () => {
  const {dispatch}=await createQaServer({buildRoot});const origin='http://127.0.0.1:18999';
  for(const path of ['/api/v1/work-inventory','/api/system-work/current'])assert.equal((await dispatch(new Request(new URL(path,origin)))).status,401);
  for(const viewer of ['joe','dell']) {
    const seeded=await (await dispatch(new Request(`${origin}/api/test/seed`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({namespace:'work-status-selftest',viewer})}))).json();
    const request=(path,init={})=>dispatch(new Request(new URL(path,origin),{...init,headers:{...init.headers,cookie:`${seeded.cookie.name}=${seeded.cookie.value}`}}));
    const board=await (await request('/api/v1/work-inventory')).json();
    assert.equal(validWorkInventoryPayload(board),true);assert.equal(board.viewer,viewer);assert.equal(board.items.length,11);assert.equal(board.census_complete,false);
    assert.equal(board.coverage.find(row=>row.kind==='portfolio_node').state,'unavailable');assert.equal(board.coverage.find(row=>row.kind==='loop').state,'partial');
    const next=await (await request(`/api/v1/work-inventory?cursor=${board.next_cursor}`)).json();assert.equal(validWorkInventoryPayload(next),true);assert.equal(next.items.length,3);assert.equal(next.next_cursor,null);
    assert.equal(new Set([...board.items,...next.items].map(row=>`${row.kind}:${row.id}`)).size,14);
    const census=await (await request('/api/v1/work-inventory?kinds=work_request')).json();assert.equal(validWorkInventoryPayload(census),true);assert.deepEqual(census.kinds,['work_request']);assert.equal(census.census_complete,true);assert.equal(census.items.every(row=>row.kind==='work_request'),true);
    const client=createLiveClient({fetchImpl:request,docContext:false});
    assert.equal(validCurrentWorkRequestsPayload(await client.currentWorkRequests()),true);
    assert.equal(validIncidentBoardPayload(await client.incidentBoard({state:'open'})),true);
    assert.equal(validCurrentWorkItemPayload(await client.currentWorkItem()),true);
  }
});

test('unsupported fixture deal creation refuses through MCP and leaves shared records unchanged', async () => {
  const {dispatch}=await createQaServer({buildRoot});const origin='http://127.0.0.1:18999';
  const seed=async viewer=>(await dispatch(new Request(`${origin}/api/test/seed`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({namespace:'unsupported-creation',viewer})}))).json();
  const joe=await seed('joe'),dell=await seed('dell');
  const request=identity=>(path,init={})=>dispatch(new Request(new URL(path,origin),{...init,headers:{...init.headers,cookie:`${identity.cookie.name}=${identity.cookie.value}`}}));
  const joeClient=createLiveClient({fetchImpl:request(joe),docContext:false});const dellClient=createLiveClient({fetchImpl:request(dell),docContext:false});
  const before=await joeClient.getBoard();
  const args={name:'Demo Unsupported Creation',client:'C-DEMO',idempotency_key:'synthetic-unsupported-create'};
  const response=await request(joe)('/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'new-deal',arguments:args}})});
  const envelope=await response.json();assert.equal(response.status,200);assert.equal(envelope.result.isError,true);
  assert.deepEqual(JSON.parse(envelope.result.content[0].text),{error:'fixture_operation_unavailable'});
  await assert.rejects(()=>joeClient.createDeal(args),/fixture_operation_unavailable/);
  assert.deepEqual((await joeClient.getBoard()).deals,before.deals);assert.deepEqual((await dellClient.getBoard()).deals,before.deals);
  assert.deepEqual((await joeClient.getChanges(null)).events,[]);assert.deepEqual((await dellClient.getChanges(null)).events,[]);
});

test('complete fixture census counts match distinct records across every HTTP page', async () => {
  const {dispatch}=await createQaServer({buildRoot});const origin='http://127.0.0.1:19000';
  const identity=await (await dispatch(new Request(`${origin}/api/test/seed`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({namespace:'census-count-selftest',viewer:'joe'})}))).json();
  const read=async query=>(await dispatch(new Request(`${origin}/api/v1/work-inventory${query}`,{headers:{cookie:`${identity.cookie.name}=${identity.cookie.value}`}}))).json();
  const pages=[];let cursor=null;
  do {
    const page=await read(cursor?`?cursor=${encodeURIComponent(cursor)}`:'');
    assert.equal(validWorkInventoryPayload(page),true);pages.push(page);cursor=page.next_cursor;
  } while(cursor);
  assert.equal(pages.length,2);
  const items=pages.flatMap(page=>page.items);
  const counted=Object.fromEntries(pages[0].coverage.filter(row=>row.state==='complete').map(row=>[row.kind,new Set(items.filter(item=>item.kind===row.kind).map(item=>item.id)).size]));
  assert.deepEqual(counted,{work_request:8,work_shape:1,slice_plan:1,governance_item:2});
  for(const page of pages)for(const row of page.coverage) {
    if(row.state==='complete')assert.equal(row.count_total,counted[row.kind]);
    else assert.equal(row.count_total,null);
  }
  assert.equal(pages[0].coverage.find(row=>row.kind==='portfolio_node').state,'unavailable');
  assert.equal(pages[0].coverage.find(row=>row.kind==='loop').state,'partial');
  assert.equal(pages.every(page=>page.census_complete===false),true);
  const status=await read('?kinds=work_request');assert.equal(status.coverage[0].count_total,8);assert.equal(status.census_complete,true);
});
