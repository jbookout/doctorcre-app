import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openDom } from './jsdom-harness.mjs';
const source=await readFile(new URL('../js/workspace-business.js',import.meta.url),'utf8');
const saveTrust=source.slice(source.indexOf('async function saveTrust('),source.indexOf('\nfunction rowFacts('));
test('S2 vendor save verifies a fresh record version and keeps the draft on concurrent change',async()=>{
 const dom=openDom('<form id="trustForm"><select name="tier"><option>Trial</option></select><input name="reason" value="My reviewed reason"><button>Save rating</button></form><p id="trustStatus"></p>',{url:'https://example.test/vendors',runScripts:'outside-only'}),w=dom.window;
 const record={id:'synthetic-vendor',ref:'V-SYNTHETIC',record_version:1};const payload={viewer:'joe',record};let writes=0,reads=0;
 Object.assign(w,{view:{record:{payload},recordId:record.id,sessionGeneration:1,signedOut:false,dataset:'vendors'},initialBootMode:{mode:'live'},recordRequestUrl:()=>'/api/v1/business/vendors/synthetic',validRecordPayload:()=>true,
 fetchRead:async()=>{reads++;return{ok:true,json:async()=>({viewer:'joe',record:{...record,record_version:2}})}},dealroomClient:async()=>({updateVendorTrust:async()=>{writes++;return{ok:true,updated:['trust_override']}}}),renderRecordPanel(){},loadRecord:async()=>{},loadList:async()=>{},expireNow(){}});
 w.eval(saveTrust+'\nglobalThis.saveTrustTest=saveTrust;');
 await w.saveTrustTest({target:w.document.getElementById('trustForm'),preventDefault(){}});
 assert.equal(reads,1);assert.equal(writes,0);assert.equal(w.view.pendingTrust,null);assert.match(w.view.trustStatus.text,/changed.*review/i);assert.equal(w.document.querySelector('[name="reason"]').value,'My reviewed reason');
});
