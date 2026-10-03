import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { mountMorningBrief } from '../js/morning-brief.js';
import { composeMorningBrief } from '../js/morning-brief-model.js';
import { dealHref } from '../js/home-dashboard-model.js';

const now = new Date(2026, 9, 3, 8);
const since = new Date(2026, 9, 2, 18).toISOString();
const deal = (id='d1', extra={}) => ({ id, name:`Synthetic ${id}`, owner:'joe', phase:'Research', attention:true, next_step:'Review old action', ...extra });
const board = () => ({ actor:'joe', deals:[deal()] });
const action = extra => ({ subject_type:'deal', subject_id:'d1', owner:'joe', due_on:'2026-10-02', what:'Review commitment', ...extra });
const event = (id='e1', extra={}) => ({ id, subject_type:'deal', subject_id:'d1', recorded_at:now.toISOString(), actor:'dell', field:'next_step', new_value:'New change', ...extra });
const compose = extra => composeMorningBrief({ board:board(), triage:{items:[]}, events:[], since, now, ...extra });
const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };
async function settle() { for(let i=0;i<12;i++) await delay(2); }
function mount(t, { client={}, getClient, stored, speech=false, clock=()=>now, timeoutMs=100, intervalMs=60_000 }={}) {
 const dom=new JSDOM('<main><section id="strip"><div class="doc-updated"></div></section></main>',{url:'https://example.test'});
 const win=dom.window, doc=win.document, spoken=[];
 win.SpeechSynthesisUtterance=class { constructor(text){this.text=text;} };
 win.speechSynthesis={speak:u=>spoken.push(u.text),cancel:()=>{}};
 if(stored) win.localStorage.setItem('doctorcre:brief:joe',JSON.stringify(stored));
 if(speech) win.localStorage.setItem('doctorcre:brief-speech','on');
 const api={getBoard:async()=>board(),todayTriage:async()=>({items:[]}),getChanges:async()=>({events:[],cursor:'c0'}),...client};
 const mounted=mountMorningBrief({document:doc,window:win,strip:doc.querySelector('#strip'),getClient:getClient||(()=>Promise.resolve(api)),now:clock,timeoutMs,intervalMs});
 t.after(()=>{mounted.dispose();dom.window.close();});
 return {win,doc,spoken,panel:doc.querySelector('#docBrief'),click:id=>doc.querySelector(`#${id}`).click(),marker:()=>JSON.parse(win.localStorage.getItem('doctorcre:brief:joe'))};
}

for(const status of [503,401,403]) test(`#1 failed board HTTP ${status} clears actions and visibly reports unavailable`,async t=>{
 let fail=false; const h=mount(t,{client:{getBoard:async()=>{if(fail) throw {status};return board();}}});await settle();fail=true;h.click('docBriefRefresh');await settle();
 assert.equal(h.panel.dataset.state,'unavailable');assert.match(h.panel.textContent,/Unavailable/);assert.equal(h.panel.querySelectorAll('a').length,0);assert.doesNotMatch(h.panel.textContent,/Review old action/);
});
for(const kind of ['rejection','hung creation','hung aggregate','malformed board']) test(`#1 ${kind} has a visible terminal error`,async t=>{
 const options=kind==='rejection'?{getClient:async()=>{throw new Error('offline');}}:kind==='hung creation'?{getClient:()=>new Promise(()=>{})}:kind==='hung aggregate'?{client:{getChanges:()=>new Promise(()=>{})}}:{client:{getBoard:async()=>({actor:'joe',deals:[null]})}};
 const h=mount(t,{...options,timeoutMs:15});h.click('docBriefOpen');await delay(60);
 assert.equal(h.panel.dataset.state,'unavailable');assert.match(h.panel.textContent,/Unavailable/);assert.doesNotMatch(h.doc.querySelector('#docBriefUpdated').textContent,/Updating/);
});
test('#2 no shown marker during a pending feed or while a ready brief is held',async t=>{
 const held=deferred(), prior={day:'2026-10-02',since,shownAt:since};
 const h=mount(t,{stored:prior,client:{getChanges:()=>held.promise}});await settle();assert.deepEqual(h.marker(),prior);
 h.doc.dispatchEvent(new h.win.KeyboardEvent('keydown',{key:'a',bubbles:true}));held.resolve({events:[],cursor:'c1'});await settle();
 assert.equal(h.panel.hidden,true);assert.deepEqual(h.marker(),prior);h.click('docBriefOpen');await settle();assert.equal(h.marker().day,'2026-10-03');
});
test('#2 navigation during the initial read leaves the next mount eligible',async t=>{
 const held=deferred();const h=mount(t,{client:{getChanges:()=>held.promise}});await settle();assert.equal(h.marker(),null);
 held.resolve({events:[],cursor:'c1'});
});
for(const dismissed of [false,true]) test(`#3 same actor rolls into a new day, dismissed=${dismissed}`,async t=>{
 let date=now; const cursors=[]; const h=mount(t,{clock:()=>date,client:{getChanges:async c=>{cursors.push(c);return {events:[],cursor:'c1'};}}});await settle();
 if(dismissed)h.click('docBriefClose');const previous=h.marker().shownAt;date=new Date(2026,9,4,8);
 h.win.dispatchEvent(new h.win.Event('online'));await settle();if(h.panel.hidden)h.click('docBriefOpen');await settle();
 assert.equal(h.marker().day,'2026-10-04');assert.equal(h.marker().since,previous);assert.ok(cursors.filter(c=>c==null).length>=2);
});
test('#4 a personal commitment on the other partner visible active deal ranks first',()=>{
 const b=compose({board:{actor:'joe',deals:[deal('d1',{owner:'dell'})]},triage:{items:[action()]}});assert.equal(b.first?.text,'Review commitment');
});
test('#5 global triage cap is incomplete, with no misleading empty Today or flag priority',()=>{
 const b=compose({triage:{items:Array.from({length:50},()=>action({owner:'dell',subject_id:'elsewhere'}))}});
 assert.equal(b.today,null);assert.equal(b.first,null);assert.equal(b.todayState,'incomplete');assert.match(b.speech,/incomplete/i);
});
test('#6 a subsequent backlog drains to its empty terminal page before publication',async t=>{
 const pages=[{events:[event('e0')],cursor:'0'},{events:[],cursor:'1'}];const h=mount(t,{client:{getChanges:async()=>pages.shift()}});await settle();
 pages.push({events:[event('e1')],cursor:'2'},{events:[event('e2',{new_value:'Newest change'})],cursor:'3'},{events:[],cursor:'4'});
 h.click('docBriefRefresh');await settle();assert.equal(pages.length,0);assert.match(h.panel.textContent,/Newest change/);assert.match(h.panel.textContent,/\+2/);
});
test('#6 exhausting the page budget does not publish partial Overnight as complete',async t=>{
 let n=0;const h=mount(t,{client:{getChanges:async()=>({events:[event(`e${n++}`)],cursor:String(n)})}});await settle();assert.match(h.panel.querySelector('#docBriefOvernight').textContent,/Unavailable/);
});
test('#7 the brief follows the strip into and out of a record dialog',async t=>{
 const h=mount(t);await settle();h.click('docBriefClose');const dialog=h.doc.createElement('dialog');dialog.setAttribute('open','');h.doc.body.append(dialog);dialog.append(h.doc.querySelector('#strip'));await settle();h.click('docBriefOpen');await settle();
 assert.equal(h.panel.parentElement,dialog);assert.equal(h.doc.activeElement.id,'docBriefTitle');h.doc.querySelector('main').prepend(h.doc.querySelector('#strip'));await settle();assert.equal(h.panel.parentElement.tagName,'MAIN');
});
test('#8 dismissal cancels loading speech intent',async t=>{
 const held=deferred();const h=mount(t,{speech:true,client:{todayTriage:()=>held.promise}});h.click('docBriefOpen');h.click('docBriefClose');held.resolve({items:[]});await settle();assert.deepEqual(h.spoken,[]);
});
test('#9 long priority retains concise first action within 75 words',()=>{
 const b=compose({triage:{items:[action({what:Array(90).fill('Review').join(' ')})]}});assert.match(b.speech,/First, Review/);assert.match(b.speech,/Synthetic d1/);assert.ok(b.speech.split(/\s+/).length<=75);
});
for(const bad of [null,action({due_on:'invalid'}),action({due_on:'2026-02-30'})])test('#10 malformed triage members remain unknown',()=>{
 assert.equal(compose({triage:{items:[bad]}}).today,null);
});
for(const bad of [null,event('',{}),event('e',{recorded_at:'invalid'}),event('e',{subject_id:null})])test('#10 malformed event members remain unknown',()=>{
 assert.equal(compose({events:[bad]}).overnight,null);
});
test('#10 legitimate excluded rows still yield an empty morning',()=>{
 const b=compose({board:{actor:'joe',deals:[deal('d1',{attention:false})]},triage:{items:[action({subject_type:'inbox'}),action({owner:'dell'})]},events:[event('e',{subject_id:'invisible'})]});assert.deepEqual(b.today,[]);assert.deepEqual(b.overnight,[]);
});
test('#11 changed polls preserve focused record identity and announce updates',async t=>{
 let n=0;const h=mount(t,{client:{getChanges:async()=>n++%2===0?{events:[event(`e${n}`)],cursor:String(n)}:{events:[],cursor:String(n)}}});await settle();
 h.doc.querySelector('#docBriefOvernight a').focus();h.click('docBriefRefresh');await settle();assert.equal(h.doc.activeElement.closest('section')?.id,'docBriefOvernight');
 assert.match(h.doc.querySelector('[role="status"]').textContent,/updated/i);
});
test('#11 waiting ready and failure states have concise status announcements',async t=>{
 const held=deferred();const h=mount(t,{client:{todayTriage:()=>held.promise}});h.doc.dispatchEvent(new h.win.KeyboardEvent('keydown',{key:'a'}));held.resolve({items:[]});await settle();assert.match(h.doc.querySelector('[role="status"]')?.textContent||'',/ready/i);
});
test('#12 reopening speaks only the fresh read after hidden changes',async t=>{
 let fresh=false;const held=deferred();const h=mount(t,{speech:true,client:{getBoard:async()=>{if(fresh)await held.promise;return {actor:'joe',deals:[deal('d1',{next_step:fresh?'Review fresh action':'Review old action'})]};}}});await settle();h.click('docBriefClose');h.spoken.length=0;fresh=true;h.click('docBriefOpen');await settle();assert.deepEqual(h.spoken,[]);held.resolve();await settle();assert.equal(h.spoken.length,1);assert.match(h.spoken[0],/fresh action/);assert.doesNotMatch(h.spoken[0],/old action/);
});
test('#13 spoken unavailable differs from empty within the word budget',()=>{
 const b=compose({triage:null,events:null});assert.notEqual(b.speech,compose().speech);assert.match(b.speech,/Today.*unavailable/i);assert.match(b.speech,/Overnight.*unavailable/i);assert.ok(b.speech.split(/\s+/).length<=75);
});
test('#14 deal navigation uses the canonical route interface',async()=>{
 const source=await readFile(new URL('../js/morning-brief-model.js',import.meta.url),'utf8');assert.match(source,/import\s*\{[^}]*dealHref[^}]*\}\s*from ['"]\.\/home-dashboard-model\.js/);assert.doesNotMatch(source,/`\/deals\?deal=/);
 const b=compose({board:{actor:'joe',deals:[deal('id with /')]}});assert.equal(b.first.href,dealHref('id with /'));
});

test('#1 actor changes invalidate retained actions before a delayed feed answers',async t=>{
 let changed=false;const held=deferred();const h=mount(t,{client:{getBoard:async()=>changed?{actor:'dell',deals:[]}:board(),getChanges:async()=>{if(changed)await held.promise;return {events:[],cursor:'c1'};}}});await settle();changed=true;h.click('docBriefRefresh');await settle();assert.equal(h.panel.querySelectorAll('a').length,0);held.resolve();
});
test('#2 manually opened loading brief does not advertise a waiting ready dot',async t=>{
 const held=deferred();const h=mount(t,{client:{todayTriage:()=>held.promise}});h.doc.dispatchEvent(new h.win.KeyboardEvent('keydown',{key:'a'}));h.click('docBriefOpen');held.resolve({items:[]});await settle();assert.equal(h.doc.querySelector('#docBriefOpen').dataset.ready,undefined);
});

test('#1 a timed-out feed cannot mutate the next refresh when its transport ignores abort',async t=>{
 let calls=0;const held=deferred();const h=mount(t,{timeoutMs:15,client:{getChanges:async()=>++calls===1?held.promise:{events:[],cursor:'fresh'}}});
 await delay(45);h.click('docBriefRefresh');await settle();assert.equal(h.panel.dataset.state,'ready');
 held.resolve({events:[event('late',{new_value:'Late stale value'})],cursor:'late'});await settle();h.click('docBriefRefresh');await settle();assert.doesNotMatch(h.panel.textContent,/Late stale value/);
});

for(const state of [{phase:'Closed'},{operating_state:'parked'}]) test('#4 personal open commitments use visible record identity independently of deal lifecycle',()=>{
 const b=compose({board:{actor:'joe',deals:[deal('d1',{owner:'dell',...state})]},triage:{items:[action()]}});assert.equal(b.first?.text,'Review commitment');
});
