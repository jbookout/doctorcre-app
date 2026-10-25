import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openDom } from './jsdom-harness.mjs';
import { mountInvoiceTracker } from '../js/invoice-tracker.js';
import { invoiceTrackerFixture } from '../js/invoice-tracker-fixture.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
async function setup(){
 const dom=openDom(await readFile(new URL('../invoices.html',import.meta.url),'utf8'),{url:'https://example.test/invoices',pretendToBeVisual:true}),w=dom.window,d=w.document;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 const payload=invoiceTrackerFixture('2026-10-02');let reads=0,writes=[];
 const client={mode:'fixture',getInvoiceTracker:async()=>{reads++;return structuredClone(payload)},markInvoicePaid:async args=>{writes.push(structuredClone(args));throw new Error('lost reply')}};
 const app=mountInvoiceTracker({document:d,window:w,client,today:()=> '2026-10-02'});await app.ready;
 const selected=d.querySelector('[data-invoice]').dataset.invoice;d.querySelector('[data-invoice]').click();
 return{dom,w,d,payload,app,writes,row:payload.entries.find(row=>row.commission_id===selected),get reads(){return reads},submit:async()=>{d.getElementById('invoicePayment').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick()}};
}
test('S2 changed invoice is reread and displayed before another payment intent is allowed',async()=>{
 const s=await setup();try{
  s.row.base_version++;s.row.gross_amount='13000';
  await s.submit();assert.equal(s.writes.length,0);assert.ok(s.reads>=2);assert.match(s.d.getElementById('invoicePaymentNotice').textContent,/changed.*review/i);
  await s.submit();assert.equal(s.writes.length,1);assert.equal(s.writes[0].base_version,2);
 }finally{s.app.dispose()}
});
test('S2 payment retry preserves the original base and key even after a newer read',async()=>{
 const s=await setup();try{
  await s.submit();assert.equal(s.writes.length,1);assert.ok(s.reads>=3,'initial read, pre-submit read, reconciliation read');
  s.row.base_version++;await s.app.refresh();const reads=s.reads;
  await s.submit();assert.deepEqual(s.writes[1],s.writes[0]);assert.equal(s.reads,reads+1,'only reconciliation reads on retry');
 }finally{s.app.dispose()}
});
