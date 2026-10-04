import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountDocCommandBar } from '../js/doc-command-bar.js';
const empty = () => ({parties:[],deals:[],connections:[],organizations:[],lead_client_links:[],deals_via_link:[],note:'Synthetic'});
function setup(t, options={}) {
 const dom=new JSDOM('<button id="opener">Open</button><dialog id="docDetail"><header></header><div class="doc-detail-grid"></div></dialog>',{url:'http://localhost/'});
 const win=dom.window, dialog=win.document.querySelector('dialog'); dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>{dialog.removeAttribute('open');dialog.dispatchEvent(new win.Event('close'));};
 const client={find:async()=>empty(),getBoard:async()=>({deals:[]}),...options.client};
 const bar=mountDocCommandBar({dialog,window:win,client:async()=>client,context:{snapshot:()=>({epoch:1,page:'home',label:'Home',selected:null}),clear(){}},pages:[{label:'Clients',href:'/clients'}],...Object.fromEntries(Object.entries(options).filter(([key])=>key!=='client'))});
 t.after(()=>{bar.dispose();win.close();});return{bar,win,dialog,input:win.document.querySelector('#docCommandInput')};
}
const settle=()=>new Promise(r=>setTimeout(r,20));
test('D and K chords cancel default, open once and focus; bare right Command, IME, repeats and modified chords pass through',t=>{
 const {win,dialog,input}=setup(t);
 for(const mods of [{metaKey:true},{ctrlKey:true}])for(const key of ['d','k']) {dialog.close();const event=new win.KeyboardEvent('keydown',{key,...mods,cancelable:true,bubbles:true});win.document.dispatchEvent(event);assert.equal(event.defaultPrevented,true);assert.equal(dialog.open,true);assert.equal(win.document.activeElement,input);}
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
