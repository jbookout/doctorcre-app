import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';

for (const width of [390,1280]) test(`partner brief controls work at ${width}px`,async t=>{
  const server=await fixtureServer();t.after(()=>server.close());
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/js/client.js',route=>route.fulfill({contentType:'text/javascript',body:'export const ACTOR_LABEL={}; export const PHASE_BY_SLUG={}; export function phaseLabel(value){return value} export async function createClient(){return window.exampleClient}'}));
  await page.route('**/brief-owner-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/app-shell.css"><link rel="stylesheet" href="/css/morning-brief.css"></head><body><nav id="host"></nav><main><h1>Example</h1></main><button id="docOpen">Doc</button><button id="docMorning">Morning brief</button><script type="module">
    import {mountAppLayout} from '/js/app-layout.js';
    import {mountMorningBrief} from '/js/morning-brief.js';
    import {localToday} from '/js/calendar-model.js';
    const day=localToday();
    const deals=['joe','dell'].map(owner=>({id:owner,name:'Example '+owner,owner,attention:true,phase:'legal',operating_state:'active',next_step:'Example step',next_date:day}));
    const items=deals.map(deal=>({id:'action-'+deal.id,item_kind:'next_action',subject_type:'deal',subject_id:deal.id,subject_name:deal.name,what:deal.next_step,due_on:day+'T00:00:00.000Z',owner_partner:deal.owner}));
    const brief={sponsor:'joe',sections:{today:{state:'ready',items},deals:{state:'ready',items:deals},loops:{state:'empty',items:[]}}};
    window.exampleClient={getBoard:async()=>({actor:'joe',deals}),morningBrief:async()=>brief,getChanges:async()=>({events:[],cursor:'end'})};
    mountAppLayout(document,document.getElementById('host'),'/example');
    window.brief=mountMorningBrief({document,window,getClient:async()=>window.exampleClient});
    await window.brief.refresh();
  </script></body></html>`}));
  await page.goto(`${server.origin}/brief-owner-test`);
  await page.locator('#appSyncTime[datetime]').waitFor({state:'attached'});
  await page.locator('#docMorning').click();
  assert.deepEqual(await page.locator('.morning-card .morning-owner').allTextContents(),['Dell','Joe']);
  for (const theme of ['dark','light']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const targets=await page.locator('#morningOwners .chip').evaluateAll(nodes=>nodes.map(node=>({label:node.textContent,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height})));
    for (const target of targets) {
      assert.ok(target.width>=44 && target.height>=44,`${theme} ${width}px ${target.label}: ${target.width}x${target.height}`);
    }
    t.diagnostic(`${theme} ${width}px chips: ${JSON.stringify(targets)}`);
  }
  await page.locator('#morningOwners [data-brief-owner="dell"]').click();
  assert.deepEqual(await page.locator('.morning-card .morning-owner').allTextContents(),['Dell']);
  assert.equal(await page.locator('#appTodayOwners [data-brief-owner="dell"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#appTodayNext [data-layout-deal]').count(),1);
  const fits=await page.locator('dialog').evaluate(node=>node.scrollWidth<=node.clientWidth);
  assert.equal(fits,true);
  assert.equal(await page.locator('#morningOwners [data-brief-owner="dell"]').evaluate(node=>getComputedStyle(node).borderRadius===getComputedStyle(document.documentElement).getPropertyValue('--radius-round').trim()),true,'reuse the pipeline owner chip style');
  await page.locator('#morningOwners [data-brief-owner="joe"]').focus();await page.keyboard.press('Enter');
  assert.deepEqual(await page.locator('.morning-card .morning-owner').allTextContents(),['Joe']);
  await page.reload();await page.locator('#appSyncTime[datetime]').waitFor({state:'attached'});
  await page.locator('#docMorning').click();
  assert.equal(await page.locator('#morningOwners [aria-pressed="true"]').textContent(),'Joe');
  assert.deepEqual(await page.locator('.morning-card .morning-owner').allTextContents(),['Joe']);
  assert.deepEqual(errors,[]);
});
