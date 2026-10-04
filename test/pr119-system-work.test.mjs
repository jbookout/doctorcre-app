import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { autoRefreshScript } from './auto-refresh-script.mjs';
const settle = async () => { for(let i=0;i<12;i++) await new Promise(r=>setImmediate(r)); };
const deferred = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };
const base = {human_ref:'WR-000123',version:1,state:'captured',title:'Synthetic concern',desired_outcome:'Safe observation',acceptance_criteria:[{id:'criterion-1',text:'Synthetic evidence'}],source:{label:'Synthetic doctrine',freshness:'current',provenance:'shared doctrine'}};
async function setup(t, card=base, read=()=>card, current=()=>({items:[]}), index=false) {
 const dom=new JSDOM(readFileSync(new URL('../system-work.html',import.meta.url),'utf8'),{url:'http://localhost/work-requests'+(index?'':'?work_request=WR-000123'),runScripts:'outside-only'});
 t.after(()=>dom.window.close()); const w=dom.window,d=w.document,calls=[];
 w.structuredClone=structuredClone;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.fetch=async(path,init={})=>{calls.push({path,init,body:init.body?JSON.parse(init.body):null});let data;
 if(path.endsWith('/session'))return new Response(JSON.stringify({actor:{display:'Synthetic partner'},csrf_token:'synthetic'}));
 if(path.endsWith('/current')) data=await current();
 else if(!init.method) data=await read(path);
 else data={human_ref:card.human_ref,challenge:'synthetic'};
 if(data instanceof Response)return data;
 return new Response(JSON.stringify({ok:true,data}));};
 const files=['doc-context-model.js','doc-context.js','uuid.js','system-work-view.js','system-work-client.js','system-work-app.js'];
 w.eval(autoRefreshScript+'\n'+files.map(name=>{const raw=readFileSync(new URL('../js/'+name,import.meta.url),'utf8');const names=[...raw.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(m=>m[1]);return '(function(){'+raw.replace(/^import [^\n]*\n/gm,'').replace(/^export /gm,'')+';Object.assign(window,{'+names.join(',')+'});})();';}).join('\n'));
 await settle();return {w,d,calls,online:async()=>{w.dispatchEvent(new w.Event('online'));await settle();},submit:async()=>{d.querySelector('#systemWorkForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();}};
}
for(const [kind,card] of [
 ['triage',base],['prepare-plan',{...base,state:'triaged'}],
 ['accept-plan',{...base,state:'triaged',plan:{scope_summary:'Original scope',plan_hash:'original-plan'}}],
 ['record-outcome',{...base,state:'ready',plan:{plan_hash:'original-plan'}}],
 ['accept-outcome',{...base,state:'ready',plan:{plan_hash:'original-plan'},pending_outcome_feedback:{feedback_hash:'original-feedback',result_summary:'Original result'}}],
]) test('PR119 finding 1: '+kind+' requires review again after polling changes its record',async t=>{
 let latest=card;const h=await setup(t,card,()=>latest);
 h.d.querySelector('[data-system-action]').click();
 for(const field of h.d.querySelectorAll('#systemWorkFields textarea'))field.value=field.name==='evidence_refs'?'safe:synthetic:receipt':'Synthetic result';
 h.d.querySelector('[name="observed_minutes"]')?.setAttribute('value','1');
 latest={...card,version:2};await h.online();await h.submit();
 assert.equal(h.calls.filter(c=>c.init.method==='POST').length,0,'changed material must never be silently confirmed');
 assert.match(h.d.querySelector('#systemWorkFormError').textContent,/changed|review/i);
});
test('PR119 finding 2: a superseded poll cannot replace a newer selection',async t=>{
 const slow=deferred();let hold=false;
 const h=await setup(t,base,path=>path.endsWith('WR-000456')?{...base,human_ref:'WR-000456',title:'Selected B'}:hold?slow.promise:base);
 hold=true;h.w.dispatchEvent(new h.w.Event('online'));await settle();
 h.d.querySelector('#workRequestRef').value='WR-000456';h.d.querySelector('#openWorkRequest').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await settle();
 slow.resolve(base);await settle();
 assert.equal(h.d.querySelector('#workRequestRef').value,'WR-000456');assert.match(h.w.location.search,/WR-000456/);assert.match(h.d.querySelector('#systemWorkStage').textContent,/Selected B/);
});
for(const failure of ['auth','network','service']) test('PR119 finding 3: '+failure+' poll disables actions until a successful current read',async t=>{
 let failed=false;const h=await setup(t,base,()=>{if(!failed)return base;if(failure==='network')throw Error('Synthetic connection failed');return new Response(JSON.stringify({error:failure==='auth'?'AUTHENTICATION_REQUIRED':'DEPENDENCY_UNAVAILABLE'}),{status:failure==='auth'?401:503});});
 h.d.querySelector('[data-system-action]').click();failed=true;await h.online();
 assert.equal(h.d.querySelector('[data-system-action]'),null);assert.equal(h.d.querySelector('#systemWorkAlert').hidden,false);await h.submit();assert.equal(h.calls.filter(c=>c.init.method==='POST').length,0);
 failed=false;await h.online();assert.ok(h.d.querySelector('[data-system-action]'));assert.equal(h.d.querySelector('#systemWorkAlert').hidden,true);
});

test('PR119 finding 4: the index rereads and recovers; late lists cannot overwrite a selection',async t=>{
 let rows=[],failure=false,held=null;const h=await setup(t,base,()=>base,()=>{if(held)return held.promise;if(failure)throw Error('Synthetic list outage');return {items:rows};},true);
 rows=[base];await h.online();assert.ok(h.d.querySelector('[data-open-work-request]'));
 failure=true;await h.online();assert.equal(h.d.querySelector('#systemWorkAlert').hidden,false);assert.equal(h.d.querySelector('[data-open-work-request]'),null);
 failure=false;await h.online();assert.ok(h.d.querySelector('[data-open-work-request]'));
 held=deferred();h.w.dispatchEvent(new h.w.Event('online'));await settle();
 h.d.querySelector('#workRequestRef').value=base.human_ref;h.d.querySelector('#openWorkRequest').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await settle();
 held.resolve({items:[]});await settle();assert.ok(h.d.querySelector('[data-system-action]'));
});
test('PR119 finding 9: supported source shape gets a completed read clock',async t=>{
 const h=await setup(t);assert.match(h.d.querySelector('.as-of').textContent,/^Updated \d{1,2}:\d{2} (AM|PM)$/);assert.ok(h.d.querySelector('[data-system-action]'));
});
