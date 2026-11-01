import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

const queuePage = '<html><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/app-shell.css"><link rel="stylesheet" href="/css/morning-brief.css"></head><body class="has-app-layout"><button id="docOpen">Doc</button><button id="docMorning">Morning brief</button></body></html>';

test('rendered brief queues show the 51st tied loop and retain readable narrow-screen controls',async t=>{
 const server=await fixtureServer();
 t.after(()=>server.close());
 const browser=await chromium.launch();
 const page=await browser.newPage({viewport:{width:390,height:844}});
 t.after(()=>browser.close());
 await page.route('**/brief-queue-fixture',route=>route.fulfill({contentType:'text/html',body:queuePage}));
 await page.goto(`${server.origin}/brief-queue-fixture`);
 await page.evaluate(async()=>{
   const {mountMorningBrief}=await import('/js/morning-brief.js');
   const empty=()=>({state:'empty',items:[]});
   const client={morningBrief:async()=>({sponsor:'joe',sections:{today:empty(),deals:empty(),loops:empty(),needs_joe:empty(),assurance_cadence:empty()}}),getChanges:async()=>({events:[]}),
     morningBriefQueue:async(_queue,{cursor}={})=>{if(window.queueChanged)return {sponsor:'joe',items:[{number:'52',kind:'open_loop',title:'Synthetic new eligible loop'}],total:1,returned:1,has_more:false,next_cursor:null};const start=cursor?50:0,count=cursor?1:50;return {sponsor:'joe',items:Array.from({length:count},(_,i)=>({number:String(start+i+1),kind:'open_loop',title:`Synthetic loop ${start+i+1}`,due_on:'2026-01-01',owner_partner:'joe'})),total:51,returned:count,has_more:!cursor,next_cursor:cursor?null:'opaque'};}};
   window.brief=mountMorningBrief({document,window,getClient:async()=>client,intervalMs:100000});
   await window.brief.refresh();await window.brief.open();
 });
 await page.getByRole('button',{name:/Open loops/}).click();
 await page.getByRole('heading',{name:'Open loops · 50 of 51'}).waitFor();
 const placed=await page.evaluate(()=>{
   const row=document.querySelector('[data-queue-item]');
   const summary=row.querySelector('summary');
   const content=document.getElementById('morningContent');
   return {gap:row.getBoundingClientRect().top-content.getBoundingClientRect().top,y:row.getBoundingClientRect().top,owners:getComputedStyle(document.getElementById('morningOwners')).display,buttons:document.querySelectorAll('[data-brief-queue]').length,summary:getComputedStyle(summary).display,cue:getComputedStyle(summary,'::before').content};
 });
 assert.ok(placed.gap<160,`first row starts ${placed.gap}px below the queue area`);
 assert.ok(placed.y<480,`first row viewport y is ${placed.y}`);
 assert.equal(placed.owners,'none');
 assert.equal(placed.buttons,0);
 assert.equal(await page.locator('[data-brief-queue-switch]').count(),1);
 assert.equal(placed.summary,'flex');
 assert.equal(placed.cue,'"▸"');
 const summary=page.locator('.morning-queue summary').first();
 await summary.focus();
 await page.keyboard.press('Enter');
 assert.equal(await page.locator('.morning-queue details').first().getAttribute('open'),'');
 assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.morning-queue summary'),'::before').content),'"▾"');
 await page.keyboard.press('Space');
 assert.equal(await page.locator('.morning-queue details').first().getAttribute('open'),null);
 await page.getByRole('button',{name:'Load more',exact:true}).click();
 await page.getByRole('heading',{name:'Open loops · 51 of 51'}).waitFor();
 assert.equal(await page.locator('[data-queue-item]').count(),51);
 await mkdir('out/test-artifacts',{recursive:true});
 await page.locator('dialog').evaluate(node=>node.scrollTop=0);
 await page.screenshot({path:'out/test-artifacts/brief-queue-mobile-header.png'});
 await page.getByText('Synthetic loop 51',{exact:true}).click();
 assert.equal(await page.locator('[data-queue-item]').last().locator('details').getAttribute('open'),'');
 assert.equal(await page.evaluate(()=>document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth),true);
 await mkdir('out/test-artifacts',{recursive:true});
 await page.screenshot({path:'out/test-artifacts/brief-queue-mobile.png'});
 await page.evaluate(()=>{window.queueChanged=true;});
 await page.getByRole('button',{name:'Refresh morning brief',exact:true}).click();
 await page.getByText('Synthetic new eligible loop',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-queue-item]').count(),1);
 await page.getByRole('heading',{name:'Open loops · 1 of 1'}).waitFor();
 assert.ok(await page.locator('#morningUpdated').getAttribute('datetime'));
 await page.getByRole('button',{name:'Back to priorities',exact:true}).click();
 await page.getByRole('button',{name:/Today queue/}).waitFor();
});

test('a failed queue chunk leaves the classic brief readable and retry reloads the chunk',async t=>{
 const server=await fixtureServer();
 t.after(()=>server.close());
 const browser=await chromium.launch();
 const page=await browser.newPage();
 t.after(()=>browser.close());
 let blockChunk=true;
 await page.route(url=>url.pathname==='/js/ui.generated.js',route=>blockChunk?route.abort():route.continue());
 await page.route('**/chunk-brief-fixture',route=>route.fulfill({contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/morning-brief.css"></head><body><button id="docOpen">Doc</button><button id="docMorning">Morning brief</button></body></html>'}));
 await page.goto(`${server.origin}/chunk-brief-fixture`);
 await page.evaluate(async()=>{
   const {mountMorningBrief}=await import('/js/morning-brief.js');
   const empty=()=>({state:'empty',items:[]});
   const client={morningBrief:async()=>({sponsor:'joe',sections:{today:{state:'ready',items:[{item_kind:'next_action',id:'na-1',what:'Review the synthetic lease',due_on:'2026-01-01',subject_name:'Demo Practice',owner_partner:'joe'}]},deals:empty(),loops:empty(),needs_joe:empty(),assurance_cadence:empty()}}),getChanges:async()=>({events:[]}),morningBriefQueue:async()=>({sponsor:'joe',items:[],total:0,returned:0,has_more:false,next_cursor:null})};
   window.brief=mountMorningBrief({document,window,getClient:async()=>client,intervalMs:100000});
   await window.brief.refresh();
   await window.brief.open();
 });
 const card=page.getByRole('button',{name:/Demo Practice/});
 await card.waitFor();
 await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
 assert.equal(await page.getByText('Brief unavailable').count(),0);
 await page.getByRole('button',{name:'Refresh morning brief',exact:true}).click();
 await card.waitFor();
 await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
 assert.equal(await page.getByText('Brief unavailable').count(),0);
 blockChunk=false;
 await page.getByRole('button',{name:'Retry',exact:true}).click();
 await page.getByRole('button',{name:/Today queue/}).waitFor();
 await card.waitFor();
 assert.equal(await page.getByText('Brief unavailable').count(),0);
});
