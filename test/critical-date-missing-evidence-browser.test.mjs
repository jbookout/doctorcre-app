import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createQaServer } from '../scripts/qa-fixture-server.mjs';
import { chromium, waitForAsync } from './browser-harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, '.github/pr-evidence/WR39.S1.J6');
let outDir, server, browser, origin;
before(async () => {
  outDir = await temporaryDirectory('critical-date-evidence-');
  await buildArtifact({ root, outDir, commit: '0'.repeat(40) });
  ({ server } = await createQaServer({ buildRoot: join(outDir, 'site') }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  await mkdir(evidence, { recursive: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) test(`critical-date evidence survives refresh at ${width}px in ${theme}`, async t => {
 const page=await browser.newPage({viewport:{width,height:960},timezoneId:'America/Chicago',reducedMotion:'reduce'});
 t.after(()=>page.close());
 await page.addInitScript(theme=>localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme})),theme);
 await page.clock.install({time:new Date('2026-10-04T17:00:00Z')});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 assert.equal((await page.request.post(`${origin}/api/test/seed`,{data:{namespace:`dates-${width}-${theme}`,viewer:'joe',reset:true}})).status(),200);
 const probe={reads:0,writes:0,empty:false,changed:false};
 await page.route('**/mcp',async route=>{
  const {params}=route.request().postDataJSON();
  if(params.name==='add-deal-note') probe.writes++;
  if(params.name!=='get-deal-room') return route.continue();
  probe.reads++;
  const response=await route.fetch();const body=await response.json();
  const content=body.result.content.find(c=>c.type==='text');const detail=JSON.parse(content.text);
  content.text=JSON.stringify({...detail,lease:null,critical_dates:probe.empty?[]:[
   {id:'undated-loi',kind:'loi_expiry',due_on:null,status:'open',note:'Synthetic LOI requirement. '+ 'Original clause text. '.repeat(35),source:probe.changed?'Synthetic refreshed clause 4':'Synthetic clause 4'},
   {id:'invalid-loi',kind:'loi_expiry',due_on:'2026-02-30',status:'passed',note:'Synthetic malformed date original',source:'Synthetic clause 5'},
   {id:'dated-loi',kind:'loi_expiry',due_on:'2026-10-05',status:'open',note:'Synthetic dated original'},
   {id:'unknown',kind:'custom_notice',due_on:null,note:'Synthetic custom original'},
  ]});
  await route.fulfill({response,json:body});
 });
 await page.goto(`${origin}/deals?mode=live`);
 await page.locator('.kanban-card').first().waitFor();
 await page.locator('.kanban-card .card-open').first().click();
 await page.locator('#detailUpdateForm').waitFor();
 const card=page.locator('[data-date-id="undated-loi"]');
 await card.waitFor();
 assert.match(await card.textContent(),/Date not recorded/);
 assert.match(await card.locator('small').textContent(),/Status: open/);
 assert.equal(await card.locator('[data-countdown]').count(),0);
 assert.match(await page.locator('[data-date-id="invalid-loi"]').textContent(),/Date unavailable.*passed/);
 assert.equal(await page.locator('[data-date-id="unknown"] > span').textContent(),'custom notice');
 assert.equal(await page.locator('.critical-date').filter({hasText:'LOI'}).getByText('Not recorded',{exact:true}).count(),0);
 await card.evaluate(n=>n.scrollIntoView({block:'center'}));
 await page.screenshot({path:join(evidence,`${width}-${theme}-overview.png`),animations:'disabled'});
 const summary=card.locator('summary');await summary.focus();await page.keyboard.press('Enter');
 assert.equal(await card.locator('details').evaluate(n=>n.open),true);
 assert.match(await card.locator('.note-original').textContent(),/Original clause text/);
 assert.equal(await card.locator('.date-source').textContent(),'Source: Synthetic clause 4');
 const geometry=await card.evaluate(n=>{
  const absent=n.parentElement.querySelector('.critical-date:not([data-date-id])');
  const style=getComputedStyle(n);const original=n.querySelector('.note-original');
  return {border:style.borderLeftStyle,color:getComputedStyle(n.querySelector('strong')).color,absentColor:getComputedStyle(absent.querySelector('strong')).color,
   height:n.getBoundingClientRect().height,absentHeight:absent.getBoundingClientRect().height,originalHeight:original.clientHeight,originalScrollHeight:original.scrollHeight};
 });
 assert.equal(geometry.border,'dashed');
 assert.notEqual(geometry.color,geometry.absentColor);
 assert.ok(geometry.absentHeight<geometry.height,'closed siblings stay compact');
 assert.ok(geometry.originalScrollHeight>geometry.originalHeight,'long evidence scrolls inside its card');
 await summary.evaluate(n=>n.scrollIntoView({block:'center'}));
 await page.screenshot({path:join(evidence,`${width}-${theme}-before-refresh.png`),animations:'disabled'});
 await page.getByLabel('Update',{exact:true}).fill('Synthetic unsaved update');
 const reads=probe.reads;
 await summary.focus();
 const refreshed=page.waitForResponse(r=>r.url().endsWith('/mcp') && r.request().postDataJSON()?.params?.name==='get-deal-room');
 await page.clock.fastForward(61_000);
 await refreshed;
 await waitForAsync(page,()=>document.activeElement?.dataset.detailFocus==='date-original:undated-loi');
 assert.ok(probe.reads>reads);
 assert.equal(await summary.evaluate(n=>document.activeElement===n),true);
 assert.equal(await card.locator('details').evaluate(n=>n.open),true);
 probe.changed=true;
 await page.locator('[data-refresh-detail]').click();
 await card.getByText(/Synthetic refreshed clause 4/).waitFor();
 assert.equal(await card.locator('details').evaluate(n=>n.open),true);
 assert.equal(await page.locator('[data-date-id="invalid-loi"] details').evaluate(n=>n.open),false);
 assert.equal(await page.getByLabel('Update',{exact:true}).inputValue(),'Synthetic unsaved update');
 const dated=page.locator('[data-date-id="dated-loi"] [data-countdown]');
 assert.equal(await dated.textContent(),'1 day');
 await page.clock.fastForward(86400000);
 await page.locator('[data-refresh-detail]').click();
 await waitForAsync(page, () => document.querySelector('[data-date-id="dated-loi"] [data-countdown]')?.textContent === 'Due today');
 assert.equal(await dated.textContent(),'Due today');
 assert.match(await card.textContent(),/Date not recorded/);
 assert.equal(probe.writes,0);
 assert.equal(await page.locator('#recordPanel').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
 await summary.evaluate(n=>n.scrollIntoView({block:'center'}));
 await page.screenshot({path:join(evidence,`${width}-${theme}.png`),animations:'disabled'});
 probe.empty=true;
 await page.locator('[data-refresh-detail]').click();
 await card.waitFor({state:'detached'});
 assert.equal(await page.locator('.critical-date').filter({hasText:'Not recorded'}).count(),6);
 assert.equal(await page.getByLabel('Update',{exact:true}).inputValue(),'Synthetic unsaved update');
 await page.getByRole('button',{name:'Back to deals',exact:true}).click();
 let signedOut=false;
 await page.route('**/auth/signout',async route=>{
  signedOut=true;
  await route.fulfill({status:302,headers:{location:'/'}});
 });
 await page.route('**/auth/session',route=>signedOut?route.fulfill({status:401,json:{error:'not_authenticated'}}):route.continue());
 await page.locator('#selfAvatar').click();
 await page.getByText('Sign out',{exact:true}).click();
 await page.waitForURL('**/public-shell/session-ended.html');
 assert.equal(await page.locator('[data-date-id], #detailUpdateForm').count(),0);
 assert.deepEqual(errors,[]);
});
