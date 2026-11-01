import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { uiBundle } from '../scripts/ui-bundle.mjs';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
const { mountActionLink } = await import('data:text/javascript;base64,' + bundle.toString('base64'));
const id = '11111111-1111-4111-8111-111111111111';
const ref = 'al1_bGQ6MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTEx';
const payload = () => ({ schema_version:'action-link-resolve.v1',ref,card:{kind:'lead_draft',id,lead_id:'22222222-2222-4222-8222-222222222222',state:'pending_approval',revision:3,subject:'Synthetic clinic introduction',body:'Hello <script>unsafe</script>\nA synthetic draft.',scheduled_for:'2026-11-04T15:00:00Z',time_zone:'America/Chicago',actions:[{action:'approve',verb:'approve-lead-draft',args:{draft_id:id,revision:3}}]} });
function setup(request) {
 const dom = new JSDOM('<div id="view"></div>',{url:`https://app.doctorcre.com/a/${ref}`});
 globalThis.window=dom.window; globalThis.document=dom.window.document;
 const root = dom.window.document.querySelector('#view');
 const mounted = mountActionLink(root,{ref,request});
 return {root,dom,mounted};
}
const answer = payload => ({kind:'payload',payload,isError:false});
async function until(check) { for(let i=0;i<100;i++){try{check();return;}catch(error){if(i===99)throw error;await delay(10);}} }

test('opening one linked draft is read-only; approval binds the displayed revision and confirms no send',async()=>{
 const calls=[];
 const {root,mounted}=setup(async(name,args)=>{calls.push({name,args});return answer(name==='resolve-action-link'?payload():{ok:true,draft_id:id,revision:3,approved:true,sent:false});});
 await until(()=>assert.match(root.textContent,/Synthetic clinic introduction/));
 assert.equal(calls.length,1); assert.equal(calls[0].name,'resolve-action-link'); assert.deepEqual(calls[0].args,{ref});
 assert.equal(root.querySelector('script'),null); assert.match(root.textContent,/<script>unsafe<\/script>/);
 const approve=root.querySelector('button'); approve.click(); approve.click();
 await until(()=>assert.match(root.textContent,/Draft approved/));
 assert.equal(calls.length,2); assert.equal(calls[1].name,'approve-lead-draft');
 assert.equal(calls[1].args.draft_id,id); assert.equal(calls[1].args.revision,3);
 assert.match(calls[1].args.idempotency_key,/^[0-9a-f-]{36}$/i); assert.match(root.textContent,/Nothing was sent/);
 mounted.dispose();
});

test('lost approval receipts retry the same key and do not claim success',async()=>{
 const writes=[];
 const {root,mounted}=setup(async(name,args)=>{
  if(name==='resolve-action-link')return answer(payload());
  writes.push(args);return writes.length===1?{kind:'unconfirmed',reason:'network'}:answer({ok:true,draft_id:id,revision:3,approved:true,sent:false});
 });
 await until(()=>assert.ok(root.querySelector('button')));root.querySelector('button').click();
 await until(()=>assert.match(root.textContent,/Approval has not been confirmed/));
 assert.doesNotMatch(root.textContent,/Draft approved/); root.querySelector('button').click();
 await until(()=>assert.match(root.textContent,/Draft approved/)); assert.deepEqual(writes[1],writes[0]);mounted.dispose();
});

test('malformed producer cards, wrong action targets and failed reads never offer approval',async()=>{
 for(const change of [p=>{p.schema_version='old';},p=>{p.card.actions[0].args.draft_id='other';},p=>{p.card.time_zone='invalid';},p=>{p.ref='other';},p=>{p.card.scheduled_for='not a date';}]){
  const value=payload();change(value);const {root,mounted}=setup(async()=>answer(value));
  await until(()=>assert.match(root.textContent,/could not be opened/));
  assert.equal([...root.querySelectorAll('button')].some(button=>button.textContent==='Approve draft'),false); mounted.dispose();
 }
});

test('unknown and foreign links are indistinguishable; stale links offer no approval',async()=>{
 for(const [code,copy] of [['action_link_not_found',/unavailable for your account/],['action_link_no_longer_actionable',/no longer awaiting approval/]]){
  const {root,mounted}=setup(async()=>({kind:'payload',payload:{error:code},isError:true}));
  await until(()=>assert.match(root.textContent,copy)); assert.equal(root.querySelector('button'),null);mounted.dispose();
 }
});

test('a stale revision clears the old draft until a fresh review',async()=>{
 let reads=0; const {root,mounted}=setup(async name=>name==='resolve-action-link'?(reads++,answer(payload())):({kind:'payload',payload:{error:'stale_draft_revision'},isError:true}));
 await until(()=>assert.match(root.textContent,/Synthetic clinic/));root.querySelector('button').click();
 await until(()=>assert.match(root.textContent,/changed/));assert.doesNotMatch(root.textContent,/Synthetic clinic/);
 root.querySelector('button').click();await until(()=>assert.match(root.textContent,/Synthetic clinic/));assert.equal(reads,2);mounted.dispose();
});

test('a mismatched approval receipt remains unconfirmed',async()=>{
 const {root,mounted}=setup(async name=>answer(name==='resolve-action-link'?payload():{ok:true,draft_id:id,revision:2,approved:true,sent:false}));
 await until(()=>assert.ok(root.querySelector('button')));root.querySelector('button').click();
 await until(()=>assert.match(root.textContent,/not been confirmed/));assert.doesNotMatch(root.textContent,/Draft approved/);mounted.dispose();
});

test('sign-in retains the exact link, and disposal ignores late private reads',async()=>{
 const signedOut=setup(async()=>({kind:'authorization',status:401}));
 await until(()=>assert.match(signedOut.root.textContent,/Sign in to open/));
 assert.equal(new URL(signedOut.root.querySelector('.btn').href).searchParams.get('return_to'),`/a/${ref}`);signedOut.mounted.dispose();
 let finish;const {root,mounted}=setup(()=>new Promise(resolve=>{finish=resolve;}));mounted.dispose();finish(answer(payload()));await delay(30);assert.equal(root.textContent,'');
});
