import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { uiBundle } from '../scripts/ui-bundle.mjs';
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
const ui = await import('data:text/javascript;base64,' + bundle.toString('base64'));
const dealId = '11111111-1111-4111-8111-111111111111';
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
function open(request) {
  const dom = new JSDOM('<div id="view"></div>');
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.FormData = dom.window.FormData;
  const element = document.querySelector('#view');
  const panel = ui.mountClientPublications(element, {dealId, request});
  return {element,panel,dom};
}
test('CLIENT-VIEW hides drafts until explicit publish and removes withdrawn content', async () => {
  const fake = ui.createPublicationFixture(); const writes = [];
  const {element,panel} = open(async (...args) => {if(args[0] === 'set-client-publication') writes.push(args[1]); return fake(...args);});
  await settle(); assert.equal(writes.length,0);
  assert.doesNotMatch(element.querySelector('[data-client-preview]').textContent,/Site visit scheduled/);
  element.querySelector('[data-publish]').click(); await settle();
  assert.equal(writes.length,1); assert.equal(writes[0].published,true);
  assert.match(element.querySelector('[data-client-preview]').textContent,/Site visit scheduled/);
  element.querySelector('[data-unpublish]').click(); await settle();
  assert.doesNotMatch(element.querySelector('[data-client-preview]').textContent,/Site visit scheduled/);
  panel.dispose();
});
test('unknown write outcome retains same key and stops new writes until explicit retry', async () => {
  const fake = ui.createPublicationFixture(); const writes = []; let fail = true;
  const {element,panel} = open(async (name,args,options) => {
    if(name === 'set-client-publication') {writes.push(args); const result = await fake(name,args,options); if(fail){fail=false; throw Error('network');} return result;}
    return fake(name,args,options);
  });
  await settle(); element.querySelector('[data-publish]').click(); await settle();
  assert.match(element.textContent,/not confirmed/); assert.equal(element.querySelector('[data-publish]'),null);
  element.querySelector('[data-retry]').click(); await settle();
  assert.deepEqual(writes[0],writes[1]); assert.match(element.querySelector('[data-client-preview]').textContent,/Site visit scheduled/); panel.dispose();
});
test('read failures hide preview, refresh retries, session invalidation fences late results', async () => {
  const fake = ui.createPublicationFixture(); let fail = true;
  const {element,panel,dom} = open(async (...args) => {if(fail) throw Error('SQL private'); return fake(...args);});
  await settle(); assert.match(element.textContent,/Client view unavailable/); assert.doesNotMatch(element.textContent,/SQL private/);
  fail = false; await panel.refresh(); assert.ok(element.querySelector('[data-client-preview]'));
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  assert.equal(element.querySelector('[data-client-preview]'),null); panel.dispose();
});
test('preview uses the server projection only, never published flags, private fields or automatic phases', async () => {
  const fake = ui.createPublicationFixture();
  const {element,panel} = open(async (name,...rest) => {
    const result = await fake(name,...rest);
    if(name === 'list-deal-client-publications') return {...result,publications:result.publications.map(p=>({...p,published:true,content:'PRIVATE DRAFT'}))};
    if(name === 'preview-deal-client-view') return {...result,portal:{...result.portal,internal_notes:'PRIVATE NOTE',roadmap:{current_phase:'INTERNAL PHASE'},materials:[{kind:'document',title:'Shared brief',content:'Public text'}],publications:[{kind:'deliverable',title:'Final packet',deliverable:{id:dealId,filename:'packet.pdf',mime:'application/pdf',bytes:500,object_key:'SECRET KEY'}}]}};
    return result;
  });
  await settle(); const preview=element.querySelector('[data-client-preview]').textContent;
  assert.match(preview,/Shared brief.*Public text.*packet.pdf/s); assert.doesNotMatch(preview,/PRIVATE|INTERNAL|SECRET|Site visit scheduled/);
  assert.equal(element.querySelector('[data-client-preview] button'),null); panel.dispose();
});
test('null portal disables publication, malformed or oversized responses fail closed', async () => {
  const fake=ui.createPublicationFixture();
  for(const portal of [null,{}, {slug:'synthetic',materials:[],publications:Array(101).fill({kind:'milestone',title:'Too many',content:'Text'})}]) {
    const {element,panel}=open(async (name,...rest)=>name==='preview-deal-client-view'?{ok:true,schema_version:'client-publications.v1',portal}:fake(name,...rest));
    await settle();
    if(portal===null) {assert.match(element.textContent,/No active client portal/); assert.equal(element.querySelector('[data-publish]').disabled,true);}
    else {assert.match(element.textContent,/Client view unavailable/); assert.equal(element.querySelector('[data-publish]'),null);}
    panel.dispose();
  }
});
test('session change during reads or a write hides all data and fences late completion', async () => {
  const fake=ui.createPublicationFixture(); let resolve; let hold = false;
  const {element,panel,dom}=open(async (name,...rest)=>{
    const response=await fake(name,...rest);
    if(hold) return new Promise(done=>{resolve=()=>done(response);});
    return response;
  });
  await settle(); hold=true; element.querySelector('[data-publish]').click(); await settle();
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated')); resolve(); await settle();
  assert.match(element.textContent,/Session changed/); assert.equal(element.querySelector('[data-client-preview]'),null); panel.dispose();
  let finish;
  const late=open(()=>new Promise(done=>{finish=done;})); late.panel.dispose(); finish({}); await settle(); assert.equal(late.element.textContent,'');
});

test('saving a new draft never publishes and form edits cause no writes', async () => {
  const fake=ui.createPublicationFixture();const writes=[];
  const {element,panel,dom}=open(async (name,args,options)=>{if(name==='set-client-publication')writes.push(args);return fake(name,args,options);});
  await settle();
  element.querySelector('[name=title]').value='New hidden milestone'; element.querySelector('[name=content]').value='Draft details';
  assert.equal(writes.length,0);
  element.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})); await settle();
  assert.equal(writes.length,1);assert.equal(writes[0].published,false);assert.equal(writes[0].base_version,0);
  assert.match(element.textContent,/New hidden milestone/);assert.doesNotMatch(element.querySelector('[data-client-preview]').textContent,/New hidden milestone|Draft details/);panel.dispose();
});
