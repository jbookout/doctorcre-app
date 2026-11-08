import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { appAssetSnapshot } from '../scripts/fixture-app-assets.mjs';
import { startWorkerFixture } from '../scripts/fixture-http.mjs';
import { prove, signedInReplyEngine } from '../scripts/prove-reply-action-link.mjs';
import { requireContainingRelease } from '../scripts/prove-fact-review-pending-status-view.mjs';
const exec = promisify(execFile);
const reply=JSON.parse(await readFile(new URL('./fixtures/action-link-reply.v2.json',import.meta.url)));
const commit='1'.repeat(40),foreignRef='al1_foreign';
const assets=await appAssetSnapshot();
async function fixture() {
 const routes=new Map(assets);routes.set('/app-release',{contentType:'application/json',body:JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:commit})});
 let writes=0;
 const server=await startWorkerFixture({routes,env:{CARR:{async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/auth/session')return Response.json({actor:{slug:'joe'},csrf_token:'synthetic-csrf'});
  if(url.pathname==='/mcp'){
   const rpc=await request.json();if(rpc.params.name!=='resolve-action-link')writes++;
   return Response.json({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify(rpc.params.arguments.ref===reply.ref?reply:{error:'action_link_not_found'})}]}});
  }
  return new Response(null);
 }}}});
 return {...server,writes:()=>writes};
}

test('reply proof uses real page exact values foreign refusal and no write',async()=>{
 const server=await fixture();
 try {
 const result=await prove({origin:server.origin,commit,ref:reply.ref,proposalId:reply.card.id,foreignRef,engine:chromium});
 assert.equal(result.status,'passed');assert.equal(server.writes(),0);
 await assert.rejects(prove({origin:server.origin,commit,ref:reply.ref,proposalId:reply.card.id.slice(0,-1)+'2',foreignRef,engine:chromium}),/exact displayed proposal identity/);
 }finally{await server.close();}
});

test('reply proof release containment covers equal descendant older unrelated and unknown without history dependencies',async()=>{
 const cwd=temporaryDirectory('reply-proof-git-');
 const git=(...args)=>exec('git',args,{cwd});
 try{
 await git('init','-q');await git('config','user.name','Synthetic');await git('config','user.email','synthetic@example.test');
 await git('commit','--allow-empty','-qm','base');const base=(await git('rev-parse','HEAD')).stdout.trim();
 await git('commit','--allow-empty','-qm','descendant');const child=(await git('rev-parse','HEAD')).stdout.trim();
 await git('checkout','--orphan','unrelated');await git('commit','--allow-empty','-qm','unrelated');const unrelated=(await git('rev-parse','HEAD')).stdout.trim();
 await requireContainingRelease(base,base,{cwd});await requireContainingRelease(base,child,{cwd});
 for(const [expected,observed] of [[child,base],[base,unrelated],[base,'f'.repeat(40)]])await assert.rejects(requireContainingRelease(expected,observed,{cwd}),{exitCode:78});
 }finally{await rm(cwd,{recursive:true,force:true});}
});

test('reply CLI containing release with unreachable CDP exits 78',async()=>{
 const server=await fixture();
 try{await assert.rejects(exec(process.execPath,['scripts/prove-reply-action-link.mjs','--origin',server.origin,'--commit',commit,'--ref',reply.ref,'--proposal-id',reply.card.id,'--foreign-ref',foreignRef,'--cdp-url','http://127.0.0.1:1','--timeout-ms','1500']),error=>error.code===78);}finally{await server.close();}
});

for(const phase of ['late launch','stalled evaluation'])test(`reply proof deadline closes owned browser for ${phase}`,async()=>{
 const server=await fixture();let alive=0;
 const engine={async launch(){if(phase==='late launch')await new Promise(resolve=>setTimeout(resolve,250));alive++;return {async close(){alive=0;},async newPage(){return {route:async()=>{},goto:async()=>{},waitForFunction:async()=>{},locator:()=>({count:()=>new Promise(()=>{})})};}};}};
 try{await assert.rejects(prove({origin:server.origin,commit,ref:reply.ref,proposalId:reply.card.id,foreignRef,engine,timeoutMs:100}),{exitCode:78});assert.equal(alive,0);}finally{await server.close();}
});

test('borrowed CDP closes late acquired tab before disconnect without touching existing pages',async()=>{
 const order=[];let finish;
 const existing={close(){throw Error('must not close existing tab');}};
 const adapter=await signedInReplyEngine('http://127.0.0.1:9222',{connectOverCDP:async()=>({contexts:()=>[{pages:()=>[existing],newPage:()=>new Promise(resolve=>{finish=resolve;})}],close:async()=>{order.push('disconnect');}})}).launch({timeout:1000});
 const pending=adapter.newPage();const close=adapter.close();finish({close:async()=>{order.push('tab');}});await pending;await close;
 assert.equal(order.at(-1),'disconnect');assert.ok(order.indexOf('tab')<order.indexOf('disconnect'));
});

test('reply CLI fixture pass and near miss fail; real CDP late page leaves existing tabs intact',async()=>{
 const server=await fixture();
 const browser=await chromium.launch({headless:true,args:[...CHROMIUM_SAFETY_ARGS,'--remote-debugging-port=0','--enable-automation']});
 let connection;
 try {
  const session=await browser.newBrowserCDPSession();
  const {arguments:args}=await session.send('Browser.getBrowserCommandLine');
  const directory=args.find(arg=>arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  const port=(await readFile(directory+'/DevToolsActivePort','utf8')).split('\n')[0];
  const endpoint=`http://127.0.0.1:${port}`;
  connection=await chromium.connectOverCDP(endpoint);
  const context=connection.contexts()[0];
  const existing=await context.newPage();
  const before=context.pages().length;
  const cli=['scripts/prove-reply-action-link.mjs','--origin',server.origin,'--commit',commit,'--ref',reply.ref,'--proposal-id',reply.card.id,'--foreign-ref',foreignRef,'--cdp-url',endpoint];
  const result=await exec(process.execPath,cli,{timeout:45000});assert.equal(JSON.parse(result.stdout).status,'passed');
  const wrong=[...cli];wrong[wrong.indexOf('--proposal-id')+1]=reply.card.id.slice(0,-1)+'2';
  await assert.rejects(exec(process.execPath,wrong,{timeout:45000}),error=>error.code===1);
  const delayed={async connectOverCDP(url,options){const connected=await chromium.connectOverCDP(url,options);const c=connected.contexts()[0];const create=c.newPage.bind(c);c.newPage=async()=>{await new Promise(resolve=>setTimeout(resolve,250));return create();};return connected;}};
  await assert.rejects(prove({origin:server.origin,commit,ref:reply.ref,proposalId:reply.card.id,foreignRef,timeoutMs:100,engine:signedInReplyEngine(endpoint,delayed)}),{exitCode:78});
  const fresh=await chromium.connectOverCDP(endpoint);
  try{assert.equal(fresh.contexts()[0].pages().length,before);assert.equal(existing.isClosed(),false);}finally{await fresh.close();}
 }finally{await connection?.close();await browser.close();await server.close();}
});
