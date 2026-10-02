import test from 'node:test';import assert from 'node:assert/strict';import {readFile,mkdir} from 'node:fs/promises';import {extname} from 'node:path';import {chromium} from 'playwright';
import {workspace,detail,id} from './leads-workspace-fixture.mjs';
const root=new URL('../',import.meta.url);
for(const width of [1440,390]) test(`Leads rendered board, map and wide popup fit ${width}px with automatic freshness`,async t=>{
 const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width,height:960},reducedMotion:'reduce'});page.setDefaultTimeout(20_000);
 await page.clock.install({time:new Date('2026-10-01T16:00:00Z')});const errors=[],writes=[];let board=workspace(),reads=0;page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!=='http://localhost')return route.abort();
 if(url.pathname==='/mcp') {const p=req.postDataJSON().params;let value={ok:true};if(p.name==='deal-room-board')value={actor:'example-partner',deals:[]};
 else if(p.name==='lead-board'){reads++;value={...board,...(p.arguments.lead_id?{detail:detail(board.leads.find(l=>l.id===p.arguments.lead_id))}:{})}}else{writes.push(p);value={ok:true}}
 return route.fulfill({contentType:'application/json',body:JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify(value)}]}})});}
 if(url.pathname.startsWith('/api/'))return route.fulfill({contentType:'application/json',body:JSON.stringify({actor:{slug:'example-partner'},csrf_token:'synthetic-test-token',items:[],counts:{}})});
 let path=url.pathname==='/leads'?'leads.html':url.pathname.slice(1);try{const body=await readFile(new URL(path,root));return route.fulfill({body,contentType:{'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.geojson':'application/geo+json'}[extname(path)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''})}
 });
 await page.goto('http://localhost/leads');await page.locator('.lead-card').first().waitFor({state:'attached'}).catch(async e=>{console.log(await page.locator('#leadBoard').innerHTML(),errors);throw e});await page.locator('.market-marker').first().waitFor({state:'attached'});
 assert.equal(await page.locator('.stage-column').count(),6);assert.equal(await page.locator('.hot-row').count(),5);
 const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,cards:[...document.querySelectorAll('.lead-card')].map(e=>e.getBoundingClientRect().right)}));assert.ok(layout.scroll<=layout.width,JSON.stringify(layout));assert.ok(layout.cards.every(r=>r<=width));
 const before=reads;board.leads[0].doctor_name='Dr. Example Updated';await page.clock.fastForward(31_000);await page.getByRole('heading',{name:'Dr. Example Updated',exact:true}).last().waitFor();assert.ok(reads>before);assert.equal(writes.length,0,'polling has no outward effects');
 assert.equal(await page.locator('.lead-card').first().evaluate(e=>getComputedStyle(e).animationName),'none');
 if(process.env.W3_SCREENSHOT_DIR){await mkdir(process.env.W3_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.W3_SCREENSHOT_DIR}/leads-${width}.png`,fullPage:true});}
 await page.locator('.lead-card').first().click();await page.locator('#detailStage').waitFor();const box=await page.locator('#leadDetail').boundingBox();assert.ok(box.width>=Math.min(1100,width-32));
 await page.locator('#detailBody details').first().locator('summary').click();assert.match(await page.locator('#detailBody').innerText(),/Original synthetic entry/);
 if(process.env.W3_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.W3_SCREENSHOT_DIR}/lead-detail-${width}.png`});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 });
