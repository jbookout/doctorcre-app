import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';
const ref='al1_bGQ6MTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTEx';
const id='11111111-1111-4111-8111-111111111111';
const payload={schema_version:'action-link-resolve.v1',ref,card:{kind:'lead_draft',id,lead_id:'22222222-2222-4222-8222-222222222222',state:'pending_approval',revision:3,subject:'Introduction to Synthetic Bayside Clinic',body:'Hello Synthetic Bayside team,\n\nI would like to introduce our practice space search.\n\nThank you.',scheduled_for:'2026-11-04T15:00:00Z',time_zone:'America/Chicago',actions:[{action:'approve',verb:'approve-lead-draft',args:{draft_id:id,revision:3}}]}};
test('linked draft opens directly, reads safely and approves at phone and desktop widths',async()=>{
 const server=await fixtureServer(), browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
 await mkdir('out/test-artifacts/action-links',{recursive:true});
 try { for(const width of [390,1440]) for(const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width,height:1000}}); const calls=[];
  await page.addInitScript(theme=>localStorage.setItem('dealroom-theme',theme),theme);
  await page.route('**/auth/session',route=>route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic-csrf'}}));
  await page.route('**/mcp',async route=>{
   const rpc=route.request().postDataJSON(); calls.push(rpc.params);
   const value=rpc.params.name==='resolve-action-link'?payload:rpc.params.name==='approve-lead-draft'?{ok:true,draft_id:id,revision:3,approved:true,sent:false}:{};
   await route.fulfill({json:{jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify(value)}]}}});
  });
  await page.goto(`${server.origin}/a/${ref}?mode=live`);
  await page.getByRole('heading',{name:payload.card.subject}).waitFor();
  assert.equal(calls.filter(call=>call.name==='approve-lead-draft').length,0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:`out/test-artifacts/action-links/${width}-${theme}-review.png`,fullPage:true});
  await page.getByRole('button',{name:'Approve draft',exact:true}).click();
  await page.getByRole('heading',{name:'Draft approved',level:1,exact:true}).waitFor();
  const leads=page.getByRole('link',{name:'Go to Leads',exact:true});
  assert.equal(await leads.getAttribute('href'),'/leads');
  assert.ok((await leads.boundingBox()).height >= 44);
  assert.notEqual(await leads.evaluate(el=>getComputedStyle(el).display),'inline');
  assert.equal(await page.getByText('Read the message before approving it.').count(),0);
  assert.match(await page.locator('#actionLink').textContent(),/Nothing was sent/);
  assert.equal(calls.filter(call=>call.name==='approve-lead-draft').length,1);
  await page.screenshot({path:`out/test-artifacts/action-links/${width}-${theme}-approved.png`,fullPage:true});
  await page.close();
 }}finally{await browser.close();await server.close();}
});

test('session refusal removes the private draft before approval can be submitted',async()=>{
 const server=await fixtureServer(),browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});
 try {
  const page=await browser.newPage();let denied=false,writes=0;
  await page.route('**/auth/session',route=>route.fulfill(denied?{status:401,json:{error:'not_authenticated'}}:{json:{actor:{slug:'joe'},csrf_token:'synthetic-csrf'}}));
  await page.route('**/mcp',route=>{
   const rpc=route.request().postDataJSON();if(rpc.params.name==='approve-lead-draft')writes++;
   return route.fulfill({json:{jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify(rpc.params.name==='resolve-action-link'?payload:{})}]}}});
  });
  await page.goto(`${server.origin}/a/${ref}?mode=live`);
  await page.getByRole('heading',{name:payload.card.subject}).waitFor();denied=true;
  await page.getByRole('button',{name:'Approve draft',exact:true}).click();
  await page.getByRole('heading',{name:'Session ended',exact:true}).waitFor();
  assert.equal(writes,0);assert.equal(await page.getByText(payload.card.subject,{exact:true}).count(),0);
 }finally{await browser.close();await server.close();}
});
