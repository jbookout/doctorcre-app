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
function setup(request, linkRef = ref) {
 const dom = new JSDOM('<div id="view"></div>',{url:`https://app.doctorcre.com/a/${ref}`});
 globalThis.window=dom.window; globalThis.document=dom.window.document;
 const root = dom.window.document.querySelector('#view');
 const mounted = mountActionLink(root,{ref:linkRef,request});
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

const reply = JSON.parse(await readFile(new URL('./fixtures/action-link-reply.v2.json', import.meta.url)));
const replySetup = request => setup(request, reply.ref);
const replyReceipt = () => ({ok:true,proposal_id:reply.card.id,version:2,status:'approved_to_send',subject:reply.card.subject,body:reply.card.body,to:reply.card.to,cc:reply.card.cc,sha256:'a'.repeat(64)});
const cloneReply = () => structuredClone(reply);
const click = root => root.querySelector('button').click();

test('recorded reply fixture satisfies producer v2 contract and opens exact review without writing',async()=>{
 const {default:Ajv}=await import('ajv/dist/2020.js');
 const schema=JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/action-link-resolve.v2.json',import.meta.url)));
 const validate=new Ajv({formats:{uuid:/^[0-9a-f-]{36}$/i,email:/^[^\s@]+@[^\s@]+\.[^\s@]+$/}}).compile(schema);
 assert.equal(validate(reply),true,JSON.stringify(validate.errors));
 const calls=[]; const {root,mounted}=replySetup(async(name,args)=>{calls.push({name,args});return answer(reply);});
 try {await until(()=>assert.match(root.textContent,/Review reply draft/));
 assert.equal(calls.length,1);assert.deepEqual(calls[0],{name:'resolve-action-link',args:{ref:reply.ref}});
 assert.match(root.textContent,new RegExp(reply.card.id)); assert.match(root.textContent,/To: sender@example.test/);assert.match(root.textContent,/CC: dell@example.test/);
 }finally{mounted.dispose();}
});

test('reply rejects mismatched ref kind action identity version content and recipients',async()=>{
 for(const change of [p=>p.ref='al1_foreign',p=>p.card.kind='arbitrary',p=>p.card.id=id,p=>p.card.source_version=2,p=>p.card.actions[0].verb='send-email',p=>p.card.actions[0].args.proposal_id=id,p=>p.card.actions[0].args.base_version=2,p=>p.card.actions[0].args.subject='other',p=>p.card.actions[0].args.body='other',p=>p.card.actions[0].args.to=['other@example.test'],p=>p.card.actions[0].args.cc=['other@example.test'],p=>p.card.extra=true]) {
  const value=cloneReply();change(value);let writes=0;
  const {root,mounted}=replySetup(async name=>{if(name!=='resolve-action-link')writes++;return answer(value);});
  try{await until(()=>assert.match(root.textContent,/could not be opened/));assert.doesNotMatch(root.textContent,/Synthetic body/);assert.equal(root.querySelector('button').textContent,'Reload draft');assert.equal(writes,0);}finally{mounted.dispose();}
 }
});

test('reply submit freezes reviewed payload double click starts once and unknown retry reuses intent',async()=>{
 const writes=[];let finish;
 const {root,mounted}=replySetup(async(name,args)=>{if(name==='resolve-action-link')return answer(reply);writes.push(structuredClone(args));return writes.length===1?new Promise(resolve=>{finish=resolve;}):answer(replyReceipt());});
 try{await until(()=>assert.match(root.textContent,/Review reply draft/));click(root);click(root);
 await until(()=>assert.equal(writes.length,1));assert.equal(root.querySelector('button').disabled,true);
 assert.deepEqual(writes[0],{...reply.card.actions[0].args,idempotency_key:writes[0].idempotency_key});
 finish({kind:'unconfirmed'});await until(()=>assert.match(root.textContent,/Submission has not been confirmed/));
 assert.doesNotMatch(root.textContent,/Reply submitted for sending/);click(root);
 await until(()=>assert.match(root.textContent,/Reply submitted for sending/));assert.deepEqual(writes[0],writes[1]);assert.match(root.textContent,/Delivery is not yet confirmed/);
 }finally{mounted.dispose();}
});

test('reply lost timeout and near miss receipts remain unconfirmed',async()=>{
 for(const result of [()=>{throw Error('timeout');},()=>({kind:'unconfirmed'}),...['proposal_id','version','subject','body','to','cc','status','sha256'].map(key=>()=>{const r=replyReceipt();r[key]=key==='version'?1:'near miss';return answer(r);})]) {
 const {root,mounted}=replySetup(async name=>name==='resolve-action-link'?answer(reply):result());
 try{await until(()=>assert.match(root.textContent,/Review reply draft/));click(root);await until(()=>assert.match(root.textContent,/Submission has not been confirmed/));assert.doesNotMatch(root.textContent,/Reply submitted for sending/);}finally{mounted.dispose();}
 }
});

test('reply expired resolved replayed and stale submit refuses without implicit reapproval',async()=>{
 for(const code of ['action_link_not_found','action_link_no_longer_actionable','email_draft_not_pending','version_conflict','key_reuse','email_draft_recipients_mismatch']) for(const stage of ['open','submit']) {
 let writes=0; const {root,mounted}=replySetup(async name=>{if(name==='resolve-action-link'&&stage==='submit')return answer(reply);if(name!=='resolve-action-link')writes++;return {kind:'payload',payload:{error:code},isError:true};});
 try{if(stage==='submit'){await until(()=>assert.match(root.textContent,/Review reply draft/));click(root);}await until(()=>assert.match(root.textContent,/unavailable|no longer|changed/));assert.doesNotMatch(root.textContent,/Synthetic body/);assert.equal(writes,stage==='submit'?1:0);assert.equal(root.querySelector('button')?.textContent,code==='version_conflict'?'Reload draft':undefined);}finally{mounted.dispose();}
 }
});

test('reply transport reload is manual and fresh resolve replaces prior data',async()=>{
 let reads=0;const newer=cloneReply();newer.card.subject='Fresh subject';newer.card.actions[0].args.subject='Fresh subject';
 const {root,mounted}=replySetup(async()=>{if(++reads===1)throw Error('network');return answer(newer);});
 try{await until(()=>assert.match(root.textContent,/could not be opened/));await delay(30);assert.equal(reads,1);click(root);await until(()=>assert.match(root.textContent,/Fresh subject/));assert.doesNotMatch(root.textContent,/Synthetic subject/);assert.equal(reads,2);}finally{mounted.dispose();}
});

test('reply signed out retains exact return path and retirement clears every phase and late result',async()=>{
 const signed=replySetup(async()=>({kind:'authorization'}));await until(()=>assert.match(signed.root.textContent,/Sign in to open/));assert.equal(new URL(signed.root.querySelector('.btn').href).searchParams.get('return_to'),`/a/${reply.ref}`);assert.doesNotMatch(signed.root.textContent,/Synthetic/);signed.mounted.dispose();
 for(const phase of ['opening','idle','submitting','unconfirmed','confirmed']) {
 let finish,signal;const {root,mounted}=replySetup(async(name,args,options)=>{signal=options.signal;if(phase==='opening'||name!=='resolve-action-link'&&phase==='submitting')return new Promise(resolve=>{finish=resolve;});return name==='resolve-action-link'?answer(reply):phase==='unconfirmed'?{kind:'unconfirmed'}:answer(replyReceipt());});
 if(phase!=='opening'){await until(()=>assert.match(root.textContent,/Review reply draft/));if(phase!=='idle'){click(root);await until(()=>assert.match(root.textContent,phase==='submitting'?/Submitting…/:phase==='unconfirmed'?/has not been confirmed/:/Reply submitted for sending/));}}
 mounted.dispose();assert.equal(signal.aborted,true);assert.equal(root.textContent,'');finish?.(answer(reply));await delay(15);assert.equal(root.textContent,'');
 }
});
