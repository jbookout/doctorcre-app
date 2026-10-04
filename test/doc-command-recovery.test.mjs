import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountDocCommand } from '../js/doc-command.js';
import { commandResults } from '../js/doc-command-model.js';
import { createFixtureClient } from '../js/fixture-client.js';
const fixture = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json',import.meta.url))).toString('base64')}` });
const invoices = await fixture.getInvoiceTracker();
const deal = (id='a', name='Synthetic Alpha', phase='Research', base='original') => ({ id,name,phase,field_base:{phase:{id:base}} });
const emptyFind = { parties:[],deals:[],organizations:[],connections:[],lead_client_links:[],deals_via_link:[],note:'No retired aliases' };
const wait = ms => new Promise(r=>setTimeout(r,ms));
const deferred = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
async function harness(t, overrides={}, options={}) {
  const dom=new JSDOM('<dialog open><form id="docCommand"><input id="docAsk" role="combobox" aria-controls="docResults"></form><ul id="docResults" role="listbox"></ul><div id="docStaged" hidden></div><p id="docCommandStatus"></p></dialog>',{url:'http://localhost/deals',pretendToBeVisual:true});
  const doc=dom.window.document, dialog=doc.querySelector('dialog'), calls=[], navigations=[];
  let board={actor:'joe',deals:[deal()]}, serial=0;
  const client={mode:'fixture',selfActor:'joe',getBoard:async()=>board,getInvoiceTracker:async()=>structuredClone(invoices),find:async()=>emptyFind,
    patchDealField:async args=>{calls.push(args);return {status:'ok',ok:true};},markInvoicePaid:async args=>{calls.push(args);return {ok:true};},...overrides};
  const args={dialog,getClient:async()=>client,pages:[],uuid:()=>`key-${++serial}`,navigate:href=>navigations.push(href),afterWrite:()=>{},planner:{library:async()=>[]},...options};
  let view=mountDocCommand(args);
  t.after(()=>{view.dispose();dom.window.close();});
  function type(text) {doc.querySelector('#docAsk').value=text;doc.querySelector('#docAsk').dispatchEvent(new dom.window.Event('input',{bubbles:true}));}
  function key(key,target=doc.querySelector('#docAsk')) {target.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
  const open=async()=>{view.focus();await wait(20);};
  await open();
  return {doc,dom,client,calls,navigations,open,type,key,setBoard:next=>{board=next;},remount:async()=>{view.dispose();view=mountDocCommand(args);await open();},dispose:()=>view.dispose(),status:()=>doc.querySelector('#docCommandStatus').textContent};
}

test('R1 closing goes to the existing completion contract without a phase-only write',async t=>{
  const h=await harness(t);h.type('move alpha to closed');h.key('Enter');h.doc.querySelector('#docStagedApprove').click();await wait(20);
  assert.deepEqual(h.calls,[]);assert.match(h.navigations[0],/\/deals\?.*deal=a.*complete=closed/);
});
test('R2 eligibility never silently resolves two matching identities',()=>{
  const rows=commandResults({text:'move alpha to legal',deals:[deal('a','Synthetic Alpha','Legal'),deal('b','Synthetic Alpha Two')]});
  assert.equal(rows.length,2);assert.equal(rows[0].action,undefined);assert.equal(rows[1].action.deal,'b');
});
test('R2 refreshing from one match to two resets automatic selection',async t=>{
  const h=await harness(t);h.type('move alpha to legal');h.setBoard({actor:'joe',deals:[deal(),deal('b','Synthetic Alpha Two')]});await h.open();h.key('Enter');await wait(10);assert.equal(h.calls.length,0);
});
test('R3 unknown move keeps the whole original request across changed bases and remount',async t=>{
  const requests=[];const h=await harness(t,{patchDealField:async args=>{requests.push(args);if(requests.length===1)throw new Error('Lost response');return {status:'ok'};}});
  h.type('move alpha to legal');h.key('Enter');await wait(30);h.setBoard({actor:'joe',deals:[deal('a','Synthetic Alpha','Diligence','new-base')]});await h.remount();h.type('move alpha to legal');h.key('Enter');await wait(30);
  assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0]);
});
for(const response of [{status:'ok',ok:false},{}]) test(`R4 ${JSON.stringify(response)} retains unknown phase outcome`,async t=>{
 const requests=[];const h=await harness(t,{patchDealField:async args=>{requests.push(args);return response;}});h.type('move alpha to legal');h.key('Enter');await wait(30);
 assert.doesNotMatch(h.status(),/moved|changed$/);assert.equal(h.doc.querySelector('#docAsk').value,'move alpha to legal');h.key('Enter');await wait(30);assert.deepEqual(requests[1],requests[0]);
});
test('R4 malformed payment retains approval and original request',async t=>{
 const requests=[];const h=await harness(t,{markInvoicePaid:async args=>{requests.push(args);return {};}});h.type('mark oak purchase paid');h.key('Enter');h.doc.querySelector('#docStagedApprove').click();await wait(30);
 assert.equal(h.doc.querySelector('#docStaged').hidden,false);h.doc.querySelector('#docStagedApprove').click();await wait(30);assert.deepEqual(requests[1],requests[0]);
});
for(const error of [{status:401},{status:403},{payload:{error:'received_on_invalid'}},{payload:{error:'version_conflict'}}]) test(`R4 decided refusal ${JSON.stringify(error)} has distinct feedback`,async t=>{
 const h=await harness(t,{patchDealField:async()=>{throw error;}});h.type('move alpha to legal');h.key('Enter');await wait(30);assert.match(h.status(),/sign in|refused|changed|version/i);assert.doesNotMatch(h.status(),/unconfirmed/i);
});
test('R5 older source reads cannot overwrite newer identities',async t=>{
 const pending=deferred();let count=0;const h=await harness(t,{getBoard:async()=>++count===1?pending.promise:{actor:'joe',deals:[deal('b','Synthetic New')]}});await h.open();pending.resolve({actor:'joe',deals:[deal('a','Synthetic Old')]});await wait(20);h.type('synthetic');assert.match(h.doc.querySelector('#docResults').textContent,/New/);assert.doesNotMatch(h.doc.querySelector('#docResults').textContent,/Old/);
});
test('R5 disposal prevents every late source render',async t=>{
 const pending=deferred();const h=await harness(t,{getBoard:async()=>pending.promise});h.type('synthetic');h.dispose();const before=h.doc.querySelector('#docResults').innerHTML;pending.resolve({actor:'joe',deals:[deal()]});await wait(20);assert.equal(h.doc.querySelector('#docResults').innerHTML,before);
});
for(const method of ['getBoard','getInvoiceTracker','find']) test(`R6 ${method} refusal clears names, staged actions and outstanding reads`,async t=>{
 const h=await harness(t);h.type('mark oak purchase paid');h.key('Enter');h.client[method]=async()=>{throw {status:403};};if(method==='find'){h.type('Synthetic');await wait(210);}else await h.open();
 assert.equal(h.doc.querySelector('#docStaged').hidden,true);assert.equal(h.doc.querySelector('#docResults').textContent,'');assert.match(h.status(),/sign in/i);assert.equal(h.doc.querySelector('#docStagedApprove'),null);
});
test('R6 actor changes discard private sources instead of combining sessions',async t=>{
 const h=await harness(t);h.type('synthetic');h.setBoard({actor:'dell',deals:[deal('b','Synthetic Other')]});await h.open();assert.doesNotMatch(h.doc.querySelector('#docResults').textContent,/Alpha/);assert.equal(h.doc.querySelector('#docStaged').hidden,true);
});
test('R7 loading, no matches, partial and unavailable have explicit feedback and retry',async t=>{
 const pending=deferred();const h=await harness(t,{getBoard:async()=>pending.promise});h.type('zzzz');assert.match(h.status(),/loading|updating/i);pending.resolve({actor:'joe',deals:[]});await wait(210);assert.match(h.status(),/no match/i);
 h.client.getInvoiceTracker=async()=>{throw new Error('Unavailable');};await h.open();assert.match(h.status(),/partial/i);
 h.client.getBoard=h.client.getInvoiceTracker=h.client.find=async()=>{throw new Error('Unavailable');};await h.open();h.type('zzzz');await wait(210);assert.match(h.status(),/unavailable/i);assert.ok(h.doc.querySelector('[data-doc-retry]'));
});
test('R7 malformed source members fail validation without rendering exceptions',async t=>{
 const h=await harness(t,{getBoard:async()=>({deals:[null]}),getInvoiceTracker:async()=>({entries:[null]}),find:async()=>({parties:[null]})},{planner:{library:async()=>[null]}});h.type('synthetic');await wait(210);assert.equal(h.doc.querySelector('#docResults').textContent,'');assert.match(h.status(),/unavailable/i);
});
test('R7 client initialization failure is rendered and retryable',async t=>{
 const h=await harness(t,{}, {getClient:async()=>{throw new Error('Boot failed');}});h.type('alpha');await wait(210);assert.match(h.status(),/unavailable/i);assert.ok(h.doc.querySelector('[data-doc-retry]'));
});
test('R8 hung phase command leaves busy by deadline and retries the immutable request',async t=>{
 const requests=[];const h=await harness(t,{patchDealField:args=>{requests.push(args);return new Promise(()=>{});}},{writeTimeoutMs:20});h.type('move alpha to legal');h.key('Enter');await wait(50);assert.equal(h.doc.querySelector('dialog').classList.contains('doc-busy'),false);h.key('Enter');await wait(50);assert.deepEqual(requests[1],requests[0]);
});
test('R9 delayed completion preserves a newer input and staged approval',async t=>{
 const pending=deferred();const h=await harness(t,{patchDealField:()=>pending.promise});h.type('move alpha to legal');h.key('Enter');h.type('mark oak purchase paid');h.key('Enter');assert.equal(h.doc.querySelector('#docStaged').hidden,false);pending.resolve({status:'ok'});await wait(30);assert.equal(h.doc.querySelector('#docAsk').value,'mark oak purchase paid');assert.equal(h.doc.querySelector('#docStaged').hidden,false);
});
test('R10 dialog-level Escape cancels a focused approval and resets combobox state',async t=>{
 const h=await harness(t);h.type('mark oak purchase paid');h.key('Enter');await h.open();assert.equal(h.doc.querySelector('#docResults').hidden,true);assert.equal(h.doc.querySelector('#docAsk').getAttribute('aria-expanded'),'false');h.key('Escape',h.doc.querySelector('#docStagedApprove'));assert.equal(h.doc.querySelector('#docStaged').hidden,true);assert.equal(h.doc.querySelector('#docAsk').value,'');assert.equal(h.doc.activeElement.id,'docAsk');
});
test('R10 completed focused approval returns focus to input',async t=>{
 const h=await harness(t);h.type('mark oak purchase paid');h.key('Enter');h.doc.querySelector('#docStagedApprove').click();await wait(30);assert.equal(h.doc.activeElement.id,'docAsk');
});
test('R13 unknown invoice amount is never shown as zero',async t=>{
 const unknown=structuredClone(invoices);unknown.entries.find(r=>r.name.includes('Oak')).gross_amount=null;
 const h=await harness(t,{getInvoiceTracker:async()=>unknown});h.type('mark oak purchase paid');h.key('Enter');assert.doesNotMatch(h.doc.querySelector('#docStaged').textContent,/\$0/);assert.match(h.doc.querySelector('#docStaged').textContent,/unknown|—/i);
});
test('R15 canonical completed Deal results get a supported Search destination',()=>{
 const [row]=commandResults({text:'synthetic closed',parties:{...emptyFind,deals:[{name:'Synthetic Closed',phase:'Closed',owner:'joe',client_ref:null}]}});assert.equal(row?.kind,'deal');assert.match(row.href,/^\/search\?q=Synthetic\+Closed/);
});

test('R3 unresolved operation blocks a different target phase until explicit reconciliation',async t=>{
 const requests=[];const h=await harness(t,{patchDealField:async args=>{requests.push(args);return {};}});h.type('move alpha to legal');h.key('Enter');await wait(30);h.type('move alpha to LOI');h.key('Enter');await wait(30);assert.equal(requests.length,1);assert.match(h.status(),/unconfirmed|check outcome/i);
});
test('R4 negative acknowledgement carrying a date refusal releases recovery without reporting success',async t=>{
 const requests=[];const h=await harness(t,{markInvoicePaid:async args=>{requests.push(args);return {ok:false,error:'received_on_invalid',hint:'Choose a valid receipt date.'};}});h.type('mark oak purchase paid');h.key('Enter');h.doc.querySelector('#docStagedApprove').click();await wait(30);assert.match(h.status(),/refused.*valid receipt date/i);assert.equal(h.doc.querySelector('#docStaged').hidden,true);
});
test('R6 refusal while a search is delayed prevents private search repopulation',async t=>{
 const pending=deferred();const h=await harness(t,{find:()=>pending.promise});h.type('synthetic');await wait(190);h.client.getBoard=async()=>{throw {status:401};};await h.open();pending.resolve({...emptyFind,parties:[{name:'Synthetic Private',kind:'party',merged:false,city:null,specialty:null,org_name:null,ref:null}]});await wait(20);assert.equal(h.doc.querySelector('#docResults').textContent,'');assert.match(h.status(),/sign in/i);
});
