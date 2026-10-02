import test from 'node:test';import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';import {chromium} from 'playwright';
import {workspace,id} from './leads-workspace-fixture.mjs';
import {routeLeads} from './leads-browser-fixture.mjs';
for(const width of [1440,390]) test(`Leads rendered board, map and wide popup fit ${width}px with automatic freshness`,async t=>{
 const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width,height:960},reducedMotion:'reduce'});page.setDefaultTimeout(20_000);
 await page.clock.install({time:new Date('2026-10-01T16:00:00Z')});const errors=[],writes=[];let board=workspace(),reads=0;page.on('pageerror',e=>errors.push(e.message));
 await routeLeads(page,{getBoard:()=>board,onRead:()=>reads++,onWrite:p=>writes.push(p)});
 await page.goto('http://localhost/leads');await page.locator('.lead-card').first().waitFor({state:'attached'}).catch(async e=>{console.log(await page.locator('#leadBoard').innerHTML(),errors);throw e});await page.locator('.market-marker').first().waitFor({state:'attached'});
 assert.equal(await page.locator('.stage-column').count(),6);assert.equal(await page.locator('.hot-row').count(),5);
 const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,cards:[...document.querySelectorAll('.lead-card')].map(e=>e.getBoundingClientRect().right)}));assert.ok(layout.scroll<=layout.width,JSON.stringify(layout));assert.ok(layout.cards.every(r=>r<=width));
 const before=reads;board.leads[0].doctor_name='Dr. Example Updated';await page.clock.fastForward(31_000);await page.getByRole('heading',{name:'Dr. Example Updated',exact:true}).last().waitFor();assert.ok(reads>before);assert.equal(writes.length,0,'polling has no outward effects');
 assert.equal(await page.locator('.lead-card').first().evaluate(e=>getComputedStyle(e).animationName),'none');
 if(process.env.W3_SCREENSHOT_DIR){await mkdir(process.env.W3_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.W3_SCREENSHOT_DIR}/leads-${width}.png`,fullPage:true});}
 const cluster=page.getByRole('button',{name:/Zoom to markets/});assert.equal(await cluster.innerText(),'14');
 await cluster.click();await page.getByRole('button',{name:'Mobile, AL: 1 leads',exact:true}).waitFor();
 await page.getByRole('button',{name:'Mobile, AL: 1 leads',exact:true}).click();
 assert.equal(await page.locator('#marketFilter').inputValue(),'Mobile, AL');assert.equal(await page.locator('.lead-card').count(),1);
 const zoomClusters=await page.getByRole('button',{name:/Zoom to markets/}).count();const canvas=await page.locator('#territoryMap canvas').elementHandle();await page.locator('#marketFilter').selectOption('');assert.equal(await page.locator('.lead-card').count(),14);
 assert.ok(await canvas.evaluate(e=>e.isConnected),'filter updates preserve the map instance');assert.equal(await page.getByRole('button',{name:/Zoom to markets/}).count(),zoomClusters,'filter updates preserve the zoomed territory');
 await page.locator('.lead-card').first().click();await page.locator('#detailStage').waitFor();const box=await page.locator('#leadDetail').boundingBox();assert.ok(box.width>=Math.min(1100,width-32));
 await page.locator('#detailBody details').first().locator('summary').click();assert.match(await page.locator('#detailBody').innerText(),/Original synthetic entry/);
 if(process.env.W3_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.W3_SCREENSHOT_DIR}/lead-detail-${width}.png`});
 await page.locator('#detailStage').selectOption('engaged');await page.locator('.stage-proposal').waitFor();
 const prompt=await page.locator('#stageDialog').boundingBox();assert.ok(prompt.width>=Math.min(680,width-32));assert.equal(await page.locator('#stageQuestions textarea').count(),0);assert.equal(await page.locator('.stage-evidence li').count(),2);
 assert.equal(writes.length,0,'opening a stage prompt never records a move');
 if(process.env.W3_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.W3_SCREENSHOT_DIR}/stage-prompt-${width}.png`});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 });
