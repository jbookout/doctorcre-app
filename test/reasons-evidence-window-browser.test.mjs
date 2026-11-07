import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium, componentDocument} from './browser-harness.mjs';
import {routeLeads} from './leads-browser-fixture.mjs';
import {practiceOriginationFixture} from '../data/fixtures/practice-origination.mjs';

for (const width of [390,1280]) for (const theme of ['light','dark']) test(`evidence window lifecycle ${width}px ${theme}`, async t => {
  const browser=await chromium.launch(); t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:1000},colorScheme:theme,timezoneId:'Pacific/Honolulu'});
  await routeLeads(page);
  await componentDocument(page,'http://localhost',{owner:'evidence window'});
  await page.evaluate(async fixture=>{
    const {mountContactReasons}=await import('/js/contact-reasons.mjs');
    document.body.innerHTML='<section id="reasons"></section><section id="home"></section>';
    const p=window.windowProbe={payload:fixture,reads:[],failure:false,held:false};
    p.mount=mountContactReasons({host:document.querySelector('#reasons'),window,client:{listPracticeOrigination:args=>{
      p.reads.push(args.before_id||null);
      if(p.failure) throw Error('transient');
      return p.held?new Promise(resolve=>{p.resolve=resolve;}):structuredClone(p.payload);
    }}});
    p.home=mountContactReasons({host:document.querySelector('#home'),window,home:true,client:{listPracticeOrigination:async()=>fixture}});
  },practiceOriginationFixture());
  const host=page.locator('#reasons'), from=host.getByLabel('Evidence from',{exact:true}), through=host.getByLabel('Evidence through',{exact:true});
  await host.locator('article').first().waitFor();
  const apply=()=>host.getByRole('button',{name:'Apply evidence window',exact:true}).click();
  await from.fill('2026-10-21'); await through.fill('2026-10-21'); await apply();
  assert.deepEqual(await host.locator('time').evaluateAll(rows=>rows.map(row=>row.dateTime)),['2026-10-21']);
  assert.match(await host.innerText(),/1 matching loaded reason/);
  for(const [a,b] of [['2026-02-30',''],['2026-10-25','2026-10-21'],['2025-02-29',''],['bad',''],['0000-01-01','']]) {
    await from.fill(a);await through.fill(b);await apply();
    await host.getByRole('alert').waitFor();
    assert.equal(await host.locator('time').getAttribute('datetime'),'2026-10-21');
  }
  await from.fill('2024-02-29');await through.fill('2024-02-29');await apply();
  assert.equal(await host.locator('article').count(),0);
  await page.evaluate(async()=>{const p=window.windowProbe;p.payload.cards[0].evidence_date='2024-02-29';p.payload.next_cursor='1';await p.mount.refresh();});
  assert.equal(await from.inputValue(),'2024-02-29');
  assert.equal(await host.locator('time').getAttribute('datetime'),'2024-02-29');
  await host.getByRole('searchbox').fill('absent');
  await host.getByRole('button',{name:'More reasons',exact:true}).click();
  await page.waitForFunction(()=>window.windowProbe.reads.length===3&&document.querySelector('#reasons').getAttribute('aria-busy')==='false');
  assert.equal(await from.inputValue(),'2024-02-29');
  assert.equal(await host.locator('article').count(),0);
  await host.getByRole('button',{name:'Clear',exact:true}).click();
  assert.equal(await from.inputValue(),''); assert.equal(await through.inputValue(),'');
  assert.equal(await host.getByRole('searchbox').evaluate(el=>el===document.activeElement),true);
  await from.fill('2026-10-21');await through.fill('2026-10-25');await through.press('Enter');
  await host.getByLabel('Source',{exact:true}).selectOption('nppes');
  await host.getByLabel('Action category').selectOption('relationship_follow_up');
  await host.getByRole('searchbox').fill('Client');
  assert.equal(await host.locator('article').count(),1);
  assert.equal(await host.getByRole('link',{name:'Follow up with DEMO-CLIENT',exact:true}).getAttribute('href'),'/clients?record=demo-client');
  assert.equal(await host.locator('time').getAttribute('datetime'),'2026-10-25');
  assert.match(await host.innerText(),/Registry and publication dates do not confirm when a practice opened/);
  assert.equal(await page.evaluate(()=>window.windowProbe.reads.length),3,'local edits never read');
  assert.equal(await page.locator('#home').getByRole('textbox').count(),0);
  assert.equal(await page.locator('#home article').count(),width===390?1:2);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await mkdir('out/test-artifacts/signal-windows',{recursive:true});
  await page.screenshot({path:`out/test-artifacts/signal-windows/${width}-${theme}.png`,fullPage:true});
  await page.evaluate(async()=>{const p=window.windowProbe;p.failure=true;await p.mount.refresh();});
  await host.getByText(/Showing last update/).waitFor();
  assert.equal(await host.locator('article').count(),1);
  await page.evaluate(()=>{window.windowProbe.failure=false;});
  await host.getByRole('button',{name:'Try again',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-retry-reasons]'));
  assert.equal(await from.inputValue(),'2026-10-21');
  await page.evaluate(()=>{const p=window.windowProbe;p.held=true;p.mount.refresh();});
  await page.waitForFunction(()=>Boolean(window.windowProbe.resolve));
  await page.evaluate(()=>{window.dispatchEvent(new Event('doctorcre-session-invalidated'));window.windowProbe.resolve(window.windowProbe.payload);});
  await host.getByText('Sign in to view contact reasons.',{exact:true}).waitFor();
  assert.equal(await host.locator('article,input').count(),0);
  await page.evaluate(()=>{const p=window.windowProbe;p.mount.dispose();p.mount.refresh();p.home.dispose();});
  assert.equal(await host.innerText(),'');
});

test('initial failure, malformed rows, empty refresh, auth denial and disposed completion',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();await routeLeads(page);
  await componentDocument(page,'http://localhost',{owner:'evidence lifecycle'});
  await page.evaluate(async fixture=>{
    const {mountContactReasons}=await import('/js/contact-reasons.mjs');document.body.innerHTML='<section id="reasons"></section>';
    const p=window.windowProbe={payload:{...fixture,contract:'invalid'},mode:'payload',reads:0};
    p.mount=mountContactReasons({host:document.querySelector('section'),window,client:{listPracticeOrigination:()=>{
      p.reads++;if(p.mode==='denied')throw Object.assign(Error('forbidden'),{status:403});
      if(p.mode==='held')return new Promise(resolve=>{p.resolve=resolve;});return structuredClone(p.payload);
    }}});
  },practiceOriginationFixture());
  const host=page.locator('#reasons');await host.getByText(/Contact reasons unavailable/).waitFor();
  await page.evaluate(fixture=>{const p=window.windowProbe;p.payload=fixture;p.payload.cards.unshift({id:'broken'});},practiceOriginationFixture());
  await host.getByRole('button',{name:'Try again',exact:true}).click();await host.locator('article').first().waitFor();
  await host.getByLabel('Evidence from',{exact:true}).fill('2026-10-26');await host.getByRole('button',{name:'Apply evidence window'}).click();
  assert.equal(await host.locator('article').count(),1);
  await page.evaluate(async()=>{const p=window.windowProbe;p.payload.cards=[];await p.mount.refresh();});
  assert.equal(await host.getByLabel('Evidence from',{exact:true}).inputValue(),'2026-10-26');
  assert.equal(await host.locator('article').count(),0);
  await page.evaluate(async()=>{const p=window.windowProbe;p.mode='denied';await p.mount.refresh();});
  await host.getByText('Sign in to view contact reasons.',{exact:true}).waitFor();
  assert.equal(await host.locator('input,article').count(),0);
  await page.evaluate(async fixture=>{
    const p=window.windowProbe;p.mount.dispose();p.mode='held';
    const {mountContactReasons}=await import('/js/contact-reasons.mjs');
    p.mount=mountContactReasons({host:document.querySelector('section'),window,client:{listPracticeOrigination:()=>{p.reads++;return new Promise(resolve=>{p.resolve=()=>resolve(fixture);});}}});
  },practiceOriginationFixture());
  await page.waitForFunction(()=>Boolean(window.windowProbe.resolve));
  const reads=await page.evaluate(()=>{const p=window.windowProbe;p.mount.dispose();p.resolve();p.mount.refresh();return p.reads;});
  assert.equal(await host.innerText(),'');assert.equal(await page.evaluate(()=>window.windowProbe.reads),reads);
});

for(const width of [390,1280])for(const theme of ['light','dark'])test(`styled full Reasons keyboard ${width}px ${theme}`,async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:1000}});
  await page.addInitScript(theme=>localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme,walkthroughSeen:{'example-partner':true}})),theme);
  let reads=0;await routeLeads(page,{getReasons:()=>{reads++;return practiceOriginationFixture();}});
  await page.goto('http://localhost/leads#contactReasons');const host=page.locator('#contactReasons');
  const from=host.getByLabel('Evidence from',{exact:true});await from.waitFor();await from.fill('2026-10-25');
  await from.press('Tab');assert.equal(await host.getByLabel('Evidence through',{exact:true}).evaluate(el=>el===document.activeElement),true);
  await host.getByLabel('Evidence through',{exact:true}).fill('2026-10-25');await host.getByLabel('Evidence through',{exact:true}).press('Enter');
  assert.equal(await host.locator('article').count(),1);
  assert.equal(await host.locator('time').getAttribute('datetime'),'2026-10-25');
  assert.equal(reads,1);
  await host.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await mkdir('out/test-artifacts/signal-windows',{recursive:true});
  await host.screenshot({path:`out/test-artifacts/signal-windows/styled-${width}-${theme}.png`});
});
