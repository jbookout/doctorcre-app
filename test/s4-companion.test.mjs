import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createPostCallClient } from '../js/post-call-client.js';
import { createCallMode } from '../js/call-mode.js';

for (const phase of ['fetch','json']) for (const method of ['publishCallContext','getStatus','syncStatus','createOutlookDraft']) {
  test(`F12 ${method} bounds hung ${phase}, including transports ignoring abort`, async () => {
    let signal;
    const client=createPostCallClient({timeoutMs:10,fetchImpl:async (url,init) => {
      signal=init.signal;
      if(phase==='fetch') return new Promise(()=>{});
      return {ok:true,json:()=>new Promise(()=>{})};
    }});
    const call=client[method]('synthetic-session','synthetic-draft','synthetic-hash');
    await assert.rejects(Promise.race([call,new Promise((_,r)=>setTimeout(()=>r(new Error('test deadline exceeded')),150))]), /timed out/i);
    assert.equal(signal.aborted,true);
  });
}

test('F12 recorder start timeout is visible, settles controls, then reads state before another start', async () => {
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  const requests=[],messages=[];
  let count=0;
  const ui=createCallMode({root:dom.window.document,requestTimeoutMs:10,toast:m=>messages.push(m),
    fetchImpl:async (url,init)=>{
      requests.push(url.split('/').at(-1));
      if(url.endsWith('/start')) return new Promise(()=>{});
      return {ok:true,json:async ()=> ++count===1 ? {state:'idle'} : {state:'recording',mode:'other_call',session:'demo-session'}};
    },setInterval:()=>1,clearInterval:()=>{},postCallClient:{},client:()=>({})});
  try {
    await ui.checkEligibility();
    dom.window.document.querySelector('#callModeConsent').checked=true;
    await Promise.race([ui.start('other_call'),new Promise((_,r)=>setTimeout(()=>r(new Error('test deadline exceeded')),150))]);
    assert.match(messages.join(' '),/outcome unknown/i);
    assert.equal(dom.window.document.querySelector('[data-call-mode-start=other_call]').disabled,false);
    dom.window.document.querySelector('#callModeConsent').checked=true;
    await ui.start('other_call');
    assert.deepEqual(requests,['state','start','state']);
    assert.equal(ui.state.callMode.state,'recording');
  } finally {ui.dispose();dom.window.close();}
});

for (const action of ['stop','refresh']) test(`F12 recorder ${action} timeout leaves a visible error and releases its control`,async()=>{
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  let calls=0;
  const ui=createCallMode({root:dom.window.document,requestTimeoutMs:10,
    fetchImpl:async()=> ++calls===1 ? {ok:true,json:async()=>({state:'recording',mode:'other_call',session:'demo-session'})} : new Promise(()=>{}),
    setInterval:()=>1,clearInterval:()=>{},postCallClient:{},client:()=>({})});
  try {
    await ui.checkEligibility();
    await Promise.race([ui[action](),new Promise((_,r)=>setTimeout(()=>r(new Error('test deadline exceeded')),150))]);
    const notice=dom.window.document.querySelector('#callModePermission');
    assert.equal(notice.hidden,false);assert.match(notice.textContent,/timed out/i);
    assert.equal(dom.window.document.querySelector('#callModeStop').disabled,false);
  }finally{ui.dispose();dom.window.close();}
});

test('F12 an uncertain Outlook draft is checked against the report without creating it twice',async()=>{
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  const report={draft_proposals:[{draft_id:'demo-draft',candidate_id:'demo-candidate',content_hash:'demo-hash',status:'confirmed'}]};
  let creates=0,reads=0;
  const postCallClient={syncStatus:async()=>({}),createOutlookDraft:async()=>{creates++;throw Object.assign(new Error('Timed out. Outcome unknown.'),{outcomeUnknown:true});},
    getStatus:async()=>{reads++;return {status:'review_ready',report:{draft_proposals:report.draft_proposals.map(d=>({...d,status:'created'}))}};}};
  const ui=createCallMode({root:dom.window.document,postCallClient,client:()=>({}),setInterval:()=>1,clearInterval:()=>{}});
  try{
    ui.state.postCall={...ui.state.postCall,session:'demo-session',status:'review_ready',report};ui.state.eligibility='available';ui.render();
    await ui.handleClick(dom.window.document.querySelector('[data-create-outlook-draft]'));
    assert.match(dom.window.document.querySelector('[data-create-outlook-draft]').textContent,/Check draft outcome/);
    await ui.handleClick(dom.window.document.querySelector('[data-create-outlook-draft]'));
    assert.equal(creates,1);assert.ok(reads>0);
    assert.match(dom.window.document.querySelector('[data-create-outlook-draft]').textContent,/Created in Outlook/);
  }finally{ui.dispose();dom.window.close();}
});

test('F12 a timed-out report stops waiting and provides report recovery',async()=>{
  const dom=new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  const ui=createCallMode({root:dom.window.document,postCallClient:createPostCallClient({timeoutMs:10,fetchImpl:()=>new Promise(()=>{})}),client:()=>({}),setInterval:()=>1,clearInterval:()=>{}});
  try{
    ui.state.eligibility='available';ui.state.postCall={...ui.state.postCall,session:'demo-session',status:'waiting_for_transcript'};
    await ui.refreshPostCall();
    assert.equal(ui.state.postCall.status,'failed');
    assert.match(dom.window.document.querySelector('#postCallStatus').textContent,/timed out/i);
    assert.ok(dom.window.document.querySelector('[data-refresh-post-call]'));
  }finally{ui.dispose();dom.window.close();}
});

test('F12 malformed post-call report is unavailable rather than waiting for transcription',async()=>{
  const client=createPostCallClient({fetchImpl:async()=>({ok:true,json:async()=>({})})});
  await assert.rejects(client.getStatus('demo-session'),/unavailable|invalid/i);
});

async function recoveryController({fetchImpl, getStatus}) {
  const dom = new JSDOM(await readFile(new URL('../index.html',import.meta.url),'utf8'));
  const pending = new Map(); let next = 0;
  const ui = createCallMode({root:dom.window.document,requestTimeoutMs:10,fetchImpl,
    postCallClient:{getStatus},client:()=>({}),
    setTimeout:fn => {pending.set(++next,fn);return next;},clearTimeout:id => pending.delete(id),
    setInterval:()=>1,clearInterval:()=>{}});
  return {ui,dom,pending,async tick() {
    const [id,fn] = pending.entries().next().value;
    pending.delete(id); fn(); await new Promise(setImmediate);
  },dispose() {ui.dispose();dom.window.close();}};
}

test('a lost Stop reply resumes report polling after state reconciliation without another Stop', async () => {
  const requests=[]; let reads=0;
  const h = await recoveryController({fetchImpl:async url => {
    requests.push(url.split('/').at(-1));
    if(url.endsWith('/stop')) return new Promise(()=>{});
    return {ok:true,json:async()=>({state:requests.length===1?'recording':'transcribing',mode:'weekly_deal_call',session:'demo-session'})};
  },getStatus:async()=>({status:++reads===1?'waiting_for_transcript':'review_ready',report:null})});
  try {
    await h.ui.checkEligibility();
    h.ui.state.postCall={...h.ui.state.postCall,session:'demo-session',status:'context_ready',weekly:true,contextReady:true};
    await h.ui.stop(); assert.equal(h.ui.state.recorderUncertain,true);
    await h.ui.stop(); await new Promise(setImmediate);
    assert.deepEqual(requests,['state','stop','state']);
    assert.equal(h.ui.state.recorderUncertain,false);
    assert.ok(h.ui.state.pollTimer);
    assert.equal(reads,1);
    await h.tick();
    assert.equal(h.ui.state.postCall.status,'review_ready');
    assert.equal(h.ui.state.pollTimer,null);
    assert.equal(h.pending.size,0);
  } finally {h.dispose();}
});

test('a successful nonterminal report retry resumes polling until ready', async () => {
  let reads=0;
  const h = await recoveryController({getStatus:async()=>{
    reads++;
    if(reads===1) throw Error('Synthetic report failure');
    return {status:['failed','waiting_for_transcript','extracting','review_ready'][reads-1],report:null};
  }});
  try {
    h.ui.state.eligibility='available';
    h.ui.startPolling('demo-session',{weekly:true});
    await new Promise(setImmediate);
    assert.equal(h.ui.state.pollTimer,null);
    await h.ui.handleClick(h.dom.window.document.querySelector('[data-refresh-post-call]'));
    await new Promise(setImmediate);
    assert.equal(h.ui.state.postCall.status,'waiting_for_transcript');
    assert.ok(h.ui.state.pollTimer);
    await h.tick(); assert.equal(h.ui.state.postCall.status,'extracting');
    await h.tick(); assert.equal(h.ui.state.postCall.status,'review_ready');
    assert.equal(reads,4);assert.equal(h.ui.state.pollTimer,null);assert.equal(h.pending.size,0);
  } finally {h.dispose();}
});
