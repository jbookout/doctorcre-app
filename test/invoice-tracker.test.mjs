import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectInvoices, invoiceSummary, validInvoiceTracker, invoiceHref } from '../js/invoice-tracker-model.js';
import { invoiceTrackerFixture, createInvoiceFixture } from '../js/invoice-tracker-fixture.js';
import { createLiveClient } from '../js/live-client.js';
import { readHomeDashboard } from '../js/home-dashboard-model.js';
const today='2026-10-02';
const payload=()=>invoiceTrackerFixture(today);
test('awaiting is a normal closed-deal state; commission amounts remain separate from benefits',()=>{
 const data=payload();data.entries[0].won_value=9999999;
 const rows=projectInvoices(data,{today});const waiting=rows.find(row=>row.status==='awaiting');
 assert.equal(waiting.age,null);assert.equal(waiting.amount,null);assert.equal(waiting.canMarkPaid,false);
 assert.equal(invoiceSummary(rows).owed,47600);assert.equal(rows.find(row=>row.deal_id==='demo-invoice-deal-1').amount,12500);
 assert.equal(invoiceSummary(rows).awaiting,1);assert.equal(invoiceSummary(rows).paid,1);
});
test('age buckets cover boundaries; overdue requires an explicit past due date; paid age freezes',()=>{
 for(const [age,bucket] of [[0,0],[30,0],[31,1],[60,1],[61,2],[90,2],[91,3]]){
  const data=payload();data.entries=[data.entries[0]];data.entries[0].commission_invoiced_on=new Date(Date.parse(today)-age*86400000).toISOString().slice(0,10);
  data.entries[0].due_on=null;const row=projectInvoices(data,{today})[0];assert.equal(row.age,age);assert.equal(row.bucket,bucket);assert.equal(row.overdue,false);
 }
 const rows=projectInvoices(payload(),{today});assert.equal(rows.filter(row=>row.overdue).length,3);
 const paid=rows.find(row=>row.status==='paid');assert.equal(paid.age,16);assert.equal(projectInvoices(payload(),{today:'2026-10-12'}).find(row=>row.key===paid.key).age,16);
});
test('one commission identity per installment; expected installments do not start aging',()=>{
 const data=payload();const row=data.entries[0];data.entries.push({...row,commission_id:'demo-second-installment',status:'expected',commission_invoiced_on:null,due_on:null,gross_amount:'3000'});
 const rows=projectInvoices(data,{today});assert.equal(rows.length,7);assert.equal(rows.find(row=>row.key==='demo-second-installment').status,'awaiting');
 assert.equal(invoiceSummary(rows).owed,47600);assert.equal(projectInvoices(data,{today,scope:'mine'}).some(row=>row.owner==='dell'),false);
});
test('invalid or incomplete snapshots remain unavailable rather than false zero',()=>{
 for(const change of [d=>d.schema_version='unversioned',d=>d.entries[0].gross_amount='NaN',d=>delete d.entries[0].invoiced_on,d=>d.entries.push(d.entries[0]),d=>d.entries[0].received_on='2026-02-30',d=>d.entries[0].status='received']){
  const data=payload();change(data);assert.equal(validInvoiceTracker(data),false);assert.equal(projectInvoices(data,{today}),null);
 }
 assert.equal(projectInvoices({...payload(),entries:[]},{today}).length,0);
});
test('fixture receipt changes one commission, guards date/version and replays the same key',async()=>{
 const adapter=createInvoiceFixture({today:()=>today});const before=await adapter.getInvoiceTracker();const first=before.entries[0];
 const args={commission_id:first.commission_id,base_version:first.base_version,received_on:today,idempotency_key:'demo-pay'};
 await assert.rejects(adapter.markInvoicePaid({...args,base_version:9}),e=>e.payload.error==='version_conflict');
 await assert.rejects(adapter.markInvoicePaid({...args,received_on:'2026-02-30'}),e=>e.payload.error==='invalid_received_on');
 await assert.rejects(adapter.markInvoicePaid({...args,received_on:'2026-10-03'}),e=>e.payload.error==='payment_date_out_of_range');
 const receipt=await adapter.markInvoicePaid(args);assert.deepEqual(await adapter.markInvoicePaid(args),receipt);
 const after=await adapter.getInvoiceTracker();assert.equal(after.entries[0].status,'received');assert.equal(after.entries[0].received_on,today);assert.deepEqual(after.entries.slice(1),before.entries.slice(1));assert.equal(after.entries[0].gross_amount,first.gross_amount);
});
test('live snapshot uses authenticated MCP and caller cancellation; receipt preserves its explicit identity',async()=>{
 const calls=[];const live=createLiveClient({fetchImpl:async(path,init)=>{calls.push({path,init});return new Response(JSON.stringify({result:{content:[{text:JSON.stringify(payload())}]}}));}});
 const signal=new AbortController().signal;await live.getInvoiceTracker({signal});const args={commission_id:'demo',base_version:1,received_on:today,idempotency_key:'demo-intent'};await live.markInvoicePaid(args);
 assert.deepEqual(calls.map(call=>JSON.parse(call.init.body).params.name),['read-invoice-tracker','record-commission-receipt']);assert.deepEqual(JSON.parse(calls[1].init.body).params.arguments,args);assert.ok(calls.every(call=>call.path==='/mcp'&&call.init.credentials==='same-origin'));assert.ok(calls[0].init.signal);
});
test('Home reads the same invoice snapshot and fails closed when it is malformed',async()=>{
 const client={getBoard:async()=>({actor:'joe',deals:[]}),getLeadBoard:async()=>({leads:[]}),getInvoiceTracker:async()=>payload()};
 const result=await readHomeDashboard(client);assert.equal(result.reads.invoices.state,'read');assert.equal(projectInvoices(result.invoices,{today}).filter(row=>row.overdue).length,3);
 client.getInvoiceTracker=async()=>({entries:[]});const bad=await readHomeDashboard(client);assert.equal(bad.invoices,null);assert.equal(bad.reads.invoices.state,'error');assert.equal(invoiceHref('demo 1'),'/invoices?invoice=demo%201');
});
test('invoice route and deterministic artifact input bind the exact separate CARR PR contract',async()=>{
 const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');const contract=JSON.parse(await read('contracts/carr-interface.v1.json'));const routes=JSON.parse(await read('contracts/app-routes.v1.json'));
 assert.equal(routes.routes['/invoices'],'invoices.html');assert.match(await read('scripts/artifact.mjs'),/"invoices.html"/);
 assert.match(contract.invoice_tracker.producer.source_commit,/^[a-f0-9]{40}$/);assert.equal(contract.invoice_tracker.amount,'commission.gross_amount');
 for(const name of ['read-invoice-tracker','record-commission-receipt'])assert.ok(contract.mcp_operations.includes(name));
});
