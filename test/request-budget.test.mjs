import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestBudget, TAB_REQUEST_LIMIT, INITIAL_ASSET_REQUEST_LIMIT, QUIET_TAB_REQUEST_LIMIT } from '../js/request-budget.mjs';
import { createSessionBoundary } from '../js/private-session.js';

test('one document has at most 600 HTTP attempts, including both auth checks, until real input',async()=>{
 const document=new EventTarget();let app=0,api=0;
 const budget=createRequestBudget({document,fetchImpl:async path=>{
  if(String(path).includes('api.doctorcre'))api++;else app++;
  return Response.json(path==='/auth/session'?{actor:{slug:'joe'},csrf_token:'synthetic'}:{ok:true});
 }});
 const boundary=createSessionBoundary({fetchImpl:budget.fetch,invalidate:()=>assert.fail('budget exhaustion is not sign-out')});
 for(let i=0;i<1000;i++)await boundary.fetch('/mcp').catch(error=>assert.equal(error.code,'request_budget_exhausted'));
 assert.equal(app,600);assert.equal(api,0);assert.equal(budget.used,TAB_REQUEST_LIMIT);
 const scroll=new Event('scroll');Object.defineProperty(scroll,'isTrusted',{value:true});document.dispatchEvent(scroll);
 await assert.rejects(boundary.verify(),{code:'request_budget_exhausted'});assert.equal(app,600);
 document.dispatchEvent(new Event('pointerdown'));assert.equal(budget.used,600,'synthetic input cannot reset the counter');
 const human=new Event('wheel');Object.defineProperty(human,'isTrusted',{value:true});document.dispatchEvent(human);
 await boundary.fetch('/mcp');assert.equal(app,603);assert.equal(budget.used,3);
 budget.dispose();
});

test('the first-party static payload fits the 400-request initialization allowance', async t => {
 const {temporaryDirectory}=await import('../scripts/temp-directory.mjs');
 const {buildArtifact}=await import('../scripts/artifact.mjs');
 const {fileURLToPath}=await import('node:url');
 const built=await buildArtifact({root:fileURLToPath(new URL('../',import.meta.url)),outDir:temporaryDirectory('quiet-tab-assets-',t),commit:'1'.repeat(40)});
 assert.equal(INITIAL_ASSET_REQUEST_LIMIT,400);assert.equal(QUIET_TAB_REQUEST_LIMIT,1000);
 assert.ok(built.manifest.files.length<=400,`static payload contains ${built.manifest.files.length} files`);
});
