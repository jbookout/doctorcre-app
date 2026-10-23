import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openDom } from './jsdom-harness.mjs';
import * as model from '../js/notifications-model.js';
import { performCommand } from '../js/command-feedback.mjs';
import { uuidv4 } from '../js/uuid.js';
import { formatClock } from '../js/visual-system.js';
const html=await readFile(new URL('../notifications.html',import.meta.url),'utf8');
const source=(await readFile(new URL('../js/notifications.js',import.meta.url),'utf8')).replace(/^import[\s\S]*?from ["'][^"']+["'];/gm,'').replace(/^boot\(\);$/m,'').replace(/^export \{ view \};$/m,'');
test('S2 preference submission checks current version, keeps the draft and requires another reviewed save',async()=>{
 const dom=openDom(html,{url:'https://example.test/updates',runScripts:'outside-only'}),w=dom.window;
 Object.assign(w,model,{performCommand,uuidv4,formatClock});
 w.eval(source+'\nglobalThis.prefApi={savePreference,view,setClient:value=>client=value,setDraft:version=>{dirty=true;draftBaseVersion=version;}};');
 const old={ok:true,exists:true,version:3,device_opt_in:false,quiet_hours_start:null,quiet_hours_end:null,timezone:'UTC'};
 const latest={...old,version:4,device_opt_in:true};let writes=0;
 w.prefApi.view.preference={state:'read',payload:old};w.prefApi.setDraft(3);
 w.document.getElementById('deviceOptIn').checked=false;
 w.prefApi.setClient({notificationPreferences:async()=>latest,setNotificationPreference:async()=>{writes++;return{ok:true}}});
 await w.prefApi.savePreference({device_opt_in:false});assert.equal(writes,0);assert.equal(w.document.getElementById('deviceOptIn').checked,false);assert.match(w.document.getElementById('prefSummary').textContent,/on/);assert.match(w.document.getElementById('prefMessage').textContent,/changed.*review/i);
});

test('S2 a preference CAS conflict after the fresh read keeps the draft beside current saved values',async()=>{
 const dom=openDom(html,{url:'https://example.test/updates',runScripts:'outside-only'}),w=dom.window;
 Object.assign(w,model,{performCommand,uuidv4,formatClock});
 w.eval(source+'\nglobalThis.prefApi={savePreference,view,setClient:value=>client=value,setDraft:version=>{dirty=true;draftBaseVersion=version;}};');
 const old={ok:true,exists:true,version:3,device_opt_in:false,quiet_hours_start:null,quiet_hours_end:null,timezone:'UTC'};
 const latest={...old,version:4,device_opt_in:true};let reads=0,writes=0;
 w.prefApi.view.preference={state:'read',payload:old};w.prefApi.setDraft(3);w.document.getElementById('deviceOptIn').checked=false;
 w.prefApi.setClient({notificationPreferences:async()=>++reads===1?old:latest,setNotificationPreference:async()=>{writes++;throw Object.assign(new Error('Version changed'),{payload:{error:'version_conflict',current_version:4}})}});
 await w.prefApi.savePreference({device_opt_in:false});assert.equal(writes,1);
 assert.equal(w.document.getElementById('deviceOptIn').checked,false,'the unsaved choice survives the authoritative conflict');
 assert.match(w.document.getElementById('prefSummary').textContent,/on/,'current saved preference is shown alongside the draft');
 assert.match(w.document.getElementById('prefMessage').textContent,/review|changed|not saved/i);
});
