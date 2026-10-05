import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { createDocContext } from '../js/doc-context-model.js';
import { deepLinkFor } from '../js/search-model.js';
import { mountDocCommandBar } from '../js/doc-command-bar.js';
const empty = () => ({parties:[],deals:[],connections:[],organizations:[],lead_client_links:[],deals_via_link:[],note:'Synthetic'});
function setup(t, options={}) {
 const dom=new JSDOM('<button id="opener">Open</button><dialog id="docDetail"><header></header><div class="doc-detail-grid"></div></dialog>',{url:'http://localhost/'});
 const win=dom.window, dialog=win.document.querySelector('dialog'); dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>{dialog.removeAttribute('open');dialog.dispatchEvent(new win.Event('close'));};
 const client={find:async()=>empty(),getBoard:async()=>({deals:[]}),...options.client};
 const context=options.context||createDocContext({page:'home'});
 const bar=mountDocCommandBar({dialog,window:win,client:async()=>client,context,pages:[{label:'Clients',href:'/clients'}],...Object.fromEntries(Object.entries(options).filter(([key])=>key!=='client'))});
 t.after(()=>{bar.dispose();win.close();});return{bar,win,dialog,context,input:win.document.querySelector('#docCommandInput')};
}
const settle=()=>new Promise(r=>setTimeout(r,20));
test('D and K chords cancel default, open once and focus; bare right Command, IME, repeats and modified chords pass through',t=>{
 const {win,dialog,input}=setup(t);
 for(const mods of [{metaKey:true},{ctrlKey:true}])for(const key of ['d','k']) {dialog.close();const event=new win.KeyboardEvent('keydown',{key,...mods,cancelable:true,bubbles:true});win.document.dispatchEvent(event);assert.equal(event.defaultPrevented,true);assert.equal(dialog.open,true);assert.equal(win.document.activeElement,input);}
 dialog.close();const repeat=new win.KeyboardEvent('keydown',{key:'d',metaKey:true,repeat:true,cancelable:true});win.document.dispatchEvent(repeat);assert.equal(repeat.defaultPrevented,true);assert.equal(dialog.open,false);
 for(const args of [{key:'Meta',code:'MetaRight',metaKey:true},{key:'d',metaKey:true,isComposing:true},{key:'d',metaKey:true,shiftKey:true},{key:'d',metaKey:true,altKey:true}]) {dialog.close();const event=new win.KeyboardEvent('keydown',{...args,cancelable:true});win.document.dispatchEvent(event);assert.equal(event.defaultPrevented,false);assert.equal(dialog.open,false);}
});
test('search typing never writes; typed result opens detail in same wide Doc dialog and keeps originals inert',async t=>{
 let calls=0;const {bar,win,input}=setup(t,{client:{find:async()=>{calls++;return{...empty(),parties:[{kind:'client',ref:'C-DEMO',name:'Demo Practice',city:null,specialty:null,org_name:null,merged:false}]};}}});bar.open();input.value='Demo';input.dispatchEvent(new win.Event('input'));await bar.refresh();
 assert.equal(calls,1);assert.match(win.document.querySelector('#docCommandResults').textContent,/Demo Practice/);win.document.querySelector('[data-doc-result]').click();assert.match(win.document.querySelector('#docCommandDetail').textContent,/Demo Practice/);assert.equal(win.document.querySelectorAll('dialog').length,1);
});
test('late query answer cannot replace a later result',async t=>{
 let release;const {bar,win,input}=setup(t,{client:{find:()=>new Promise(r=>release=r)}});bar.open();input.value='old';input.dispatchEvent(new win.Event('input'));const pending=bar.refresh();await settle();input.value='Clients';input.dispatchEvent(new win.Event('input'));release(empty());await pending;assert.match(win.document.querySelector('#docCommandResults').textContent,/Clients/);
});
test('plain language page opening is immediate; unknown requests cannot invent an action',async t=>{
 const paths=[];const {bar,win,input}=setup(t,{navigate:p=>paths.push(p)});bar.open();input.value='open clients';input.dispatchEvent(new win.Event('input'));win.document.querySelector('#docCommandForm').dispatchEvent(new win.Event('submit',{cancelable:true}));assert.deepEqual(paths,['/clients']);
 input.value='send the invoice';input.dispatchEvent(new win.Event('input'));await bar.refresh();win.document.querySelector('#docCommandForm').dispatchEvent(new win.Event('submit',{cancelable:true}));await settle();assert.match(win.document.querySelector('#docCommandStatus').textContent,/unavailable/i);assert.deepEqual(paths,['/clients']);
});
test('authorization loss clears results and selected detail; polling preserves query',async t=>{
 let denied=false;const {bar,win,input}=setup(t,{client:{find:async()=>{if(denied)throw Object.assign(new Error('Denied'),{status:401});return{...empty(),parties:[{kind:'vendor',name:'Demo Vendor',ref:'V-DEMO',merged:false}]};}}});bar.open();input.value='Demo';input.dispatchEvent(new win.Event('input'));await bar.refresh();win.document.querySelector('[data-doc-result]').click();denied=true;await bar.refresh();assert.equal(input.value,'Demo');assert.equal(win.document.querySelectorAll('[data-doc-result]').length,0);assert.equal(win.document.querySelector('#docCommandDetail').textContent,'');
});
test('tour matches share result navigation and authorization refusal clears them',async t=>{
 let denied=false;const {bar,win,input}=setup(t,{tours:async()=>{if(denied)throw Object.assign(new Error('Denied'),{status:403});return[{id:'tour-demo',name:'Demo Tour'}];}});bar.open();input.value='Demo';input.dispatchEvent(new win.Event('input'));await bar.refresh();assert.match(win.document.querySelector('#docCommandResults').textContent,/Demo Tour/);win.document.querySelector('[data-doc-result]').click();assert.equal(win.document.querySelector('#docCommandDetail a').getAttribute('href'),'/tours?tour=tour-demo');denied=true;await bar.refresh();assert.equal(win.document.querySelectorAll('[data-doc-result]').length,0);
});
test('selected deal notes are short previews with inert original entries',async t=>{
 const original='<img src=x onerror=alert(1)> '+ 'Synthetic notes. '.repeat(30);
 const {bar,win,input}=setup(t,{client:{getBoard:async()=>({deals:[{id:'d-demo',name:'Demo Deal',phase:'Legal',next_step:original}]})}});bar.open();input.value='Demo';input.dispatchEvent(new win.Event('input'));await bar.refresh();win.document.querySelector('[data-doc-result]').click();await settle();assert.equal(win.document.querySelectorAll('#docCommandDetail img').length,0);assert.match(win.document.querySelector('#docCommandDetail').textContent,/Details/);assert.equal(win.document.querySelector('#docCommandDetail details p').textContent,original);
});

test('queued native close from an earlier opening cannot cancel a reopened query',async t=>{
 const {bar,win,dialog,input}=setup(t);bar.open();dialog.removeAttribute('open');bar.open();input.value='Clients';input.dispatchEvent(new win.Event('input'));dialog.dispatchEvent(new win.Event('close'));await new Promise(r=>setTimeout(r,220));assert.match(win.document.querySelector('#docCommandResults').textContent,/Clients/);assert.equal(win.document.activeElement,input);
});
test('automatic refresh updates results and preserves query and expanded original',async t=>{
 let phase='Research';const {bar,win,input}=setup(t,{intervalMs:30,client:{getBoard:async()=>({deals:[{id:'d-demo',name:'Demo Deal',phase,next_step:'Synthetic note. More detail.'}]})}});bar.open();input.value='Demo';input.dispatchEvent(new win.Event('input'));await bar.refresh();win.document.querySelector('[data-doc-result]').click();win.document.querySelector('#docCommandDetail details').open=true;phase='Legal';await new Promise(r=>setTimeout(r,90));assert.match(win.document.querySelector('#docCommandDetail').textContent,/Legal/);assert.equal(input.value,'Demo');assert.equal(win.document.querySelector('#docCommandDetail details').open,true);
});

const party=(ref,name='Demo Practice',kind='client')=>({kind,ref,name,merged:false});
const search=async(env,query='Demo')=>{env.bar.open();env.input.value=query;env.input.dispatchEvent(new env.win.Event('input'));await env.bar.refresh();};
const submit=env=>env.win.document.querySelector('#docCommandForm').dispatchEvent(new env.win.Event('submit',{cancelable:true}));
const heading=env=>env.win.document.querySelector('#docCommandDetail h3')?.textContent;
const selectedTitle=env=>env.win.document.querySelector('[aria-selected="true"]')?.textContent;

test('R2 stale query authorization refusal invalidates a later pending success',async t=>{
 const old=Promise.withResolvers(),later=Promise.withResolvers();let calls=0,clears=0;
 const env=setup(t,{client:{find:()=>++calls===1?old.promise:later.promise}});
 const clear=env.context.clear;env.context.clear=()=>{clears++;clear();};
 env.bar.open();env.input.value='old';env.input.dispatchEvent(new env.win.Event('input'));const first=env.bar.refresh();await settle();
 env.input.value='Demo';env.input.dispatchEvent(new env.win.Event('input'));const second=env.bar.refresh();await settle();
 old.reject(Object.assign(new Error('Denied'),{status:401}));await first;
 later.resolve({...empty(),parties:[party('C-DEMO')]});await second;
 assert.equal(clears,1);assert.equal(env.win.document.querySelectorAll('[data-doc-result]').length,0);
 assert.match(env.win.document.querySelector('#docCommandStatus').textContent,/Sign in/);
});
test('R2 every protected leg observes authorization after an earlier generic failure',async t=>{
 const board=Promise.withResolvers(),later=Promise.withResolvers();let calls=0,clears=0;
 const env=setup(t,{client:{find:()=>++calls===1?Promise.reject(new Error('Offline')):later.promise,getBoard:()=>calls===1?board.promise:Promise.resolve({deals:[]})}});
 const clear=env.context.clear;env.context.clear=()=>{clears++;clear();};
 await search(env);const pending=env.bar.refresh();await settle();
 board.reject(Object.assign(new Error('Denied'),{status:403}));await settle();
 later.resolve({...empty(),parties:[party('C-DEMO')]});await pending;
 assert.equal(clears,1);assert.equal(env.win.document.querySelectorAll('[data-doc-result]').length,0);
});
for(const source of ['clear','page refusal','suggestion refusal'])test(`R3 shared ${source} clears global detail and rejects a pending pre-refusal success`,async t=>{
 let held=null;const env=setup(t,{client:{find:()=>held?held.promise:Promise.resolve({...empty(),parties:[party('C-DEMO')]})}});
 await search(env);env.win.document.querySelector('[data-doc-result]').click();assert.ok(heading(env));
 held=Promise.withResolvers();const pending=env.bar.refresh();await settle();
 if(source==='clear')env.context.clear();else env.context.fail(null,source==='page refusal'?{status:401}:{code:'authentication_required'});
 assert.equal(env.win.document.querySelector('#docCommandDetail').textContent,'');
 assert.equal(env.win.document.querySelectorAll('[data-doc-result]').length,0);
 held.resolve({...empty(),parties:[party('C-DEMO')]});await pending;
 assert.equal(env.win.document.querySelectorAll('[data-doc-result]').length,0);
});
test('R3 ordinary page filters do not invalidate global search',async t=>{
 const env=setup(t,{client:{find:async()=>({...empty(),parties:[party('C-DEMO')]})}});await search(env);
 env.context.filter({owner:'joe'});assert.equal(env.win.document.querySelectorAll('[data-doc-result]').length,1);
});
for(const refs of [[null,null],['C-DUP','C-DUP']])test(`R4 ambiguous party refs ${JSON.stringify(refs)} never associate refreshed detail`,async t=>{
 const env=setup(t,{client:{find:async()=>({...empty(),parties:[party(refs[0],'Demo First'),party(refs[1],'Demo Second')]})}});
 await search(env);env.win.document.querySelectorAll('[data-doc-result]')[1].click();assert.equal(heading(env),'Demo Second');
 await env.bar.refresh();assert.equal(env.win.document.querySelector('#docCommandDetail').hidden,true);assert.equal(heading(env),undefined);
});
test('R4 name-only deals do not create canonical identity or refresh associations',async t=>{
 const env=setup(t,{client:{find:async()=>({...empty(),deals:[{name:'Demo Deal',phase:'Research'}]})}});await search(env);
 env.win.document.querySelector('[data-doc-result]').click();assert.equal(heading(env),'Demo Deal');assert.equal(env.win.document.querySelector('#docCommandDetail a'),null);
 await env.bar.refresh();assert.equal(heading(env),undefined);
});
test('R4 unique refs refresh exact records even when titles change',async t=>{
 let name='Demo Practice';const env=setup(t,{client:{find:async()=>({...empty(),parties:[party('C-DEMO',name)]})}});await search(env);
 env.win.document.querySelector('[data-doc-result]').click();name='Demo Renamed';await env.bar.refresh();assert.equal(heading(env),name);
});
test('R5 insertion, reorder and removal retain highlighted identity and button focus',async t=>{
 let rows=[party('C-A','Demo A'),party('C-B','Demo B')];const env=setup(t,{client:{find:async()=>({...empty(),parties:rows})}});await search(env);
 env.input.dispatchEvent(new env.win.KeyboardEvent('keydown',{key:'ArrowDown',cancelable:true}));
 env.win.document.querySelectorAll('[data-doc-result]')[1].focus();
 for(const next of [[party('C-X','Demo X'),...rows],[rows[1],rows[0],party('C-X','Demo X')]]){
  rows=next;await env.bar.refresh();assert.match(selectedTitle(env),/Demo B/);assert.match(env.win.document.activeElement.textContent,/Demo B/);
 }
 submit(env);assert.equal(heading(env),'Demo B');
 env.win.document.querySelector('[aria-selected="true"]').focus();rows=[party('C-A','Demo A')];await env.bar.refresh();
 assert.equal(selectedTitle(env),undefined);assert.equal(env.win.document.activeElement,env.input);submit(env);assert.equal(heading(env),undefined);
});
for(const control of ['a','summary'])test(`R6 detail refresh preserves ${control} focus, unchanged DOM and expanded original`,async t=>{
 let phase='Research';const env=setup(t,{client:{getBoard:async()=>({deals:[{id:'d-demo',name:'Demo Deal',phase,next_step:'Synthetic notes. '.repeat(30)}]})}});await search(env);
 env.win.document.querySelector('[data-doc-result]').click();const target=env.win.document.querySelector('#docCommandDetail');target.querySelector('details').open=true;
 const original=target.querySelector(control);original.focus();await env.bar.refresh();assert.equal(target.querySelector(control),original);assert.equal(env.win.document.activeElement,original);
 phase='Legal';await env.bar.refresh();assert.equal(env.win.document.activeElement,target.querySelector(control));assert.equal(target.querySelector('details').open,true);
});
test('R6 missing detail control falls back deliberately to Back',async t=>{
 let note='Synthetic notes. '.repeat(30);const env=setup(t,{client:{getBoard:async()=>({deals:[{id:'d-demo',name:'Demo Deal',next_step:note}]})}});await search(env);
 env.win.document.querySelector('[data-doc-result]').click();env.win.document.querySelector('#docCommandDetail summary').focus();note=null;await env.bar.refresh();assert.equal(env.win.document.activeElement.id,'docCommandBack');
});
test('R7 empty-input page suggestions activate with ArrowDown and Enter',t=>{
 const paths=[];const env=setup(t,{pages:[{label:'Home',href:'/'},{label:'Clients',href:'/clients'}],navigate:p=>paths.push(p)});env.bar.open();
 env.input.dispatchEvent(new env.win.KeyboardEvent('keydown',{key:'ArrowDown',cancelable:true}));submit(env);assert.deepEqual(paths,['/clients']);
});
test('R9 command bar reuses the party deep-link policy',async t=>{
 const source=await readFile(new URL('../js/doc-command-bar.js',import.meta.url),'utf8');assert.match(source,/href:\s*deepLinkFor\(r\)/);
 for(const kind of ['client','vendor','lead','party']){
  const row=party('REF','Demo & Practice',kind);const env=setup(t,{client:{find:async()=>({...empty(),parties:[row]})}});await search(env);env.win.document.querySelector('[data-doc-result]').click();assert.equal(env.win.document.querySelector('#docCommandDetail a')?.getAttribute('href')||null,deepLinkFor(row));
 }
});

test('R5 removal clears focused detail and returns to the search input',async t=>{
 let rows=[party('C-DEMO')];const env=setup(t,{client:{find:async()=>({...empty(),parties:rows})}});await search(env);
 env.win.document.querySelector('[data-doc-result]').click();env.win.document.querySelector('#docCommandDetail a').focus();rows=[];await env.bar.refresh();assert.equal(env.win.document.activeElement,env.input);
});
test('R5 ArrowUp after highlight removal starts from the last remaining result',async t=>{
 let rows=[party('C-DEMO')];const env=setup(t,{client:{find:async()=>({...empty(),parties:rows})}});await search(env);
 rows=[party('C-A','Demo A'),party('C-B','Demo B')];await env.bar.refresh();assert.equal(selectedTitle(env),undefined);
 env.input.dispatchEvent(new env.win.KeyboardEvent('keydown',{key:'ArrowUp',cancelable:true}));assert.match(selectedTitle(env),/Demo B/);
});
