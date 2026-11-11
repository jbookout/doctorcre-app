import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { chromium } from './browser-harness.mjs';
import { startFixture } from '../scripts/fixture-http.mjs';
import { territoryFixture } from './fixtures/territory-pages/fixture.mjs';
const assets = await uiAssets(path => readFile(path, 'utf8'));
async function setup(t, count, holdInitial = false) {
  const server = await startFixture({ routes: new Map([['/', { body: '<body></body>', contentType: 'text/html' }], ...[...assets].map(([p,body])=>['/'+p,{body,contentType:'text/javascript'}])]) });
  t.after(()=>server.close());
  const browser = await chromium.launch(); t.after(()=>browser.close());
  const page = await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(server.origin);
  await page.evaluate(async response => {
    const { mountTerritoryEvidence } = await import('/js/ui-territory-evidence.generated.js');
    window.calls=0; window.payload=response; window.failure=null; window.pending=null;
    const host=document.createElement('div'); document.body.append(host);
    window.view=mountTerritoryEvidence(host,{getTerritoryStateBoard:async()=>{window.calls++;if(window.failure)throw window.failure;return window.pending||window.payload;}},()=>{});
  }, territoryFixture(count));
  if (holdInitial) await page.evaluate(() => { window.pending = new Promise(resolve => { window.release = resolve; }); });
  await page.getByText('Recorded territory conditions',{exact:true}).press('Enter');
  await page.locator('.territory-evidence > details').evaluate(el=>{el.open=true;el.dispatchEvent(new Event('toggle'));});
  await page.getByRole('status').first().waitFor();
  return page;
}
for (const count of [0,1,20,21,45]) test(`contract checked ${count} areas appear once in server order`,async t=>{
  const page=await setup(t,count), seen=[];
  for(let offset=0;offset<Math.max(1,count);offset+=20){
    const expected=territoryFixture(count).submarkets.slice(offset,offset+20).map(r=>`${r.city}, ${r.state}`);
    const actual=await page.locator('tbody th').allTextContents();assert.deepEqual(actual,expected);seen.push(...actual);
    assert.equal(await page.getByRole('status').first().textContent(),`Showing ${count?offset+1:0}–${Math.min(offset+20,count)} of ${count} matching loaded areas / ${count} total loaded areas`);
    if(offset+20<count)await page.getByRole('button',{name:'Next areas',exact:true}).press('Enter');
  }
  assert.equal(new Set(seen).size,count);assert.equal(await page.evaluate(()=>window.calls),1);
  if(count>20){await page.getByRole('button',{name:'Previous areas',exact:true}).press('Enter');assert.equal(await page.locator('tbody th').first().textContent(),`${territoryFixture(count).submarkets[Math.floor((count-1)/20)*20-20].city}, TX`);}
});
test('condition resets, evidence retains, refresh and clear reset, stale completion cannot resurrect',async t=>{
  const page=await setup(t,45), next=page.getByRole('button',{name:'Next areas',exact:true});
  await next.click(); await page.getByLabel('Evidence view',{exact:true}).selectOption('historical');
  assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0020, TX');
  await page.locator('select').first().selectOption('conflicting');
  assert.equal(await page.locator('tbody tr').count(),20);await next.click();
  assert.equal(await page.locator('tbody tr').count(),3);
  await page.getByRole('button',{name:'Refresh evidence',exact:true}).click();
  assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await page.locator('select').first().selectOption('all');await next.click();
  await page.evaluate(async()=>{let release;window.pending=new Promise(r=>release=r);const stale=window.view.refresh();window.pending=null;await window.view.refresh();release({...window.payload,submarkets:[]});await stale;});
  assert.equal(await page.locator('tbody tr').count(),20);
  await page.evaluate(async()=>{let release;window.pending=new Promise(r=>release=r);const stale=window.view.refresh();window.view.clear();release(window.payload);await stale;window.pending=null;});
  assert.equal(await page.locator('tbody tr').count(),0);
  await page.locator('.territory-evidence > details').evaluate(el=>{el.open=true;el.dispatchEvent(new Event('toggle'));});
  assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await next.click();await page.evaluate(async()=>{window.failure={code:'unauthorized'};await window.view.refresh();window.failure=null;});
  assert.equal(await page.locator('tbody tr').count(),0);
  await page.locator('.territory-evidence > details').evaluate(el=>{el.open=true;el.dispatchEvent(new Event('toggle'));});
  assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await page.locator('tbody summary').first().press('Enter');assert.equal(await page.locator('tbody details').first().getAttribute('open'),'');
  await page.evaluate(async()=>{let release;window.pending=new Promise(r=>release=r);const stale=window.view.refresh();window.view.dispose();release(window.payload);await stale;});
  assert.equal(await page.locator('.territory-evidence').count(),0);
});
test('empty condition, boundary guards, refusal, oversized payload and retry preserve limits',async t=>{
  const page=await setup(t,45),next=page.getByRole('button',{name:'Next areas',exact:true}),previous=page.getByRole('button',{name:'Previous areas',exact:true});
  await previous.dispatchEvent('click');assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await next.click();await next.click();await next.dispatchEvent('click');assert.equal(await page.locator('tbody tr').count(),5);
  await page.locator('select').first().selectOption('tight');
  assert.equal(await page.getByRole('status').first().textContent(),'Showing 0–0 of 0 matching loaded areas / 45 total loaded areas');
  await page.locator('select').first().selectOption('all');await next.click();
  await page.evaluate(async()=>{window.failure={code:'territory_board_limit_exceeded'};await window.view.refresh();window.failure=null;});
  assert.match(await page.getByRole('alert').textContent(),/no partial results/);assert.equal(await page.locator('tbody tr').count(),0);
  await page.evaluate(async()=>{const original=window.payload;window.payload={...original,submarkets:Array.from({length:1001},()=>original.submarkets[0])};await window.view.refresh();window.payload=original;});
  assert.equal(await page.getByRole('alert').textContent(),'Territory evidence unavailable. Refresh to try again.');assert.equal(await page.locator('tbody tr').count(),0);
  await page.getByRole('button',{name:'Refresh evidence',exact:true}).click();assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await page.getByRole('button',{name:'Apply filters',exact:true}).click();assert.equal(await page.locator('tbody th').first().textContent(),'Recorded area 0000, TX');
  await page.evaluate(()=>window.view.dispose());
});

const firstArea = page => page.locator('tbody th').first().textContent();
const nextAreas = page => page.getByRole('button', { name: 'Next areas', exact: true }).dispatchEvent('click');
async function moveTo(page, position) {
  for (let i = 0; i < position; i++) await nextAreas(page);
}
async function deferredRefresh(page) {
  await page.evaluate(() => {
    window.pending = new Promise(resolve => { window.release = resolve; });
    window.refreshing = window.view.refresh();
  });
}
async function finishRefresh(page) {
  await page.evaluate(async () => {
    window.release(window.payload);
    await window.refreshing;
    window.pending = null;
  });
}
for (const [rule, position] of [['EmptyFirst', 1], ['EmptyLast', 2]]) {
  test(`invariant ${rule}: empty matches show zero and cannot page`, async t => {
    const page = await setup(t, 45);
    await moveTo(page, position);
    await page.locator('select').first().selectOption('tight');
    await nextAreas(page);
    assert.equal(await page.locator('tbody tr').count(), 0);
    assert.equal(await page.getByRole('status').first().textContent(), 'Showing 0–0 of 0 matching loaded areas / 45 total loaded areas');
  });
}
test('invariant FewThird: 23 matching areas have exactly two pages', async t => {
  const page = await setup(t, 45);
  await moveTo(page, 2);
  await page.locator('select').first().selectOption('conflicting');
  await nextAreas(page);
  await nextAreas(page);
  assert.equal(await firstArea(page), 'Recorded area 0040, TX');
  assert.equal(await page.locator('tbody tr').count(), 3);
  assert.equal(await page.getByRole('status').first().textContent(), 'Showing 21–23 of 23 matching loaded areas / 45 total loaded areas');
});
for (const [rule, position, operation] of [
  ['IdleFirst', 1, 'clear'], ['IdleLast', 2, 'clear'],
  ['DisposedFirst', 1, 'dispose'], ['DisposedLast', 2, 'dispose'],
]) {
  test(`invariant ${rule}: ${operation} retires the page and late load`, async t => {
    const page = await setup(t, 45);
    await moveTo(page, position);
    await deferredRefresh(page);
    await page.evaluate(operation => window.view[operation](), operation);
    await finishRefresh(page);
    assert.equal(await page.locator('tbody tr').count(), 0);
    if (operation === 'clear') {
      await page.locator('.territory-evidence > details').evaluate(el => { el.open = true; el.dispatchEvent(new Event('toggle')); });
      assert.equal(await firstArea(page), 'Recorded area 0000, TX');
    } else {
      assert.equal(await page.locator('.territory-evidence').count(), 0);
    }
  });
}
for (const [rule, position] of [['ResetMiddle', 1], ['ResetLast', 2]]) {
  test(`invariant ${rule}: conditions and successful refresh reset the page`, async t => {
    const page = await setup(t, 45);
    for (const condition of ['conflicting', 'all']) {
      await moveTo(page, position);
      await page.locator('select').first().selectOption(condition);
      assert.equal(await firstArea(page), 'Recorded area 0000, TX');
    }
    await moveTo(page, position);
    await page.getByRole('button', { name: 'Refresh evidence', exact: true }).click();
    assert.equal(await firstArea(page), 'Recorded area 0000, TX');
  });
}
for (const [rule, position] of [
  ['KeepFirstMiddle', 0], ['KeepFirstLast', 0], ['KeepMiddleFirst', 1],
  ['KeepMiddleLast', 1], ['KeepLastFirst', 2], ['KeepLastMiddle', 2],
]) {
  test(`invariant ${rule}: evidence selection preserves exact area identities`, async t => {
    const page = await setup(t, 45);
    await moveTo(page, position);
    const areas = await page.locator('tbody th').allTextContents();
    for (const evidence of ['historical', 'current', 'all']) {
      await page.getByLabel('Evidence view', { exact: true }).selectOption(evidence);
      assert.deepEqual(await page.locator('tbody th').allTextContents(), areas);
    }
    assert.equal(await page.evaluate(() => window.calls), 1);
  });
}
test('invariant RetiredReady: stale completion never restores a cleared panel', async t => {
  const page = await setup(t, 45);
  await deferredRefresh(page);
  await page.evaluate(() => window.view.clear());
  await finishRefresh(page);
  assert.equal(await page.locator('tbody tr').count(), 0);
  assert.equal(await page.getByRole('status').count(), 0);
});
test('invariant DisposedOwner: disposed panel never starts another read', async t => {
  const page = await setup(t, 45);
  await page.evaluate(async () => { window.view.dispose(); await window.view.refresh(); });
  assert.equal(await page.evaluate(() => window.calls), 1);
  assert.equal(await page.locator('.territory-evidence').count(), 0);
});

test('transitions: full and filtered next, previous and boundary controls remain local', async t => {
  const page = await setup(t, 45);
  const previous = page.getByRole('button', { name: 'Previous areas', exact: true });
  for (const condition of ['all', 'conflicting']) {
    await page.locator('select').first().selectOption(condition);
    await previous.dispatchEvent('click');
    assert.equal(await firstArea(page), 'Recorded area 0000, TX');
    await nextAreas(page);
    assert.equal(await firstArea(page), condition === 'all' ? 'Recorded area 0020, TX' : 'Recorded area 0040, TX');
    if (condition === 'all') {
      await nextAreas(page);
      assert.equal(await firstArea(page), 'Recorded area 0040, TX');
    }
    await nextAreas(page);
    assert.equal(await firstArea(page), 'Recorded area 0040, TX');
    await previous.dispatchEvent('click');
    assert.equal(await firstArea(page), condition === 'all' ? 'Recorded area 0020, TX' : 'Recorded area 0000, TX');
    if (condition === 'all') await previous.dispatchEvent('click');
    assert.equal(await firstArea(page), 'Recorded area 0000, TX');
  }
  assert.equal(await page.evaluate(() => window.calls), 1);
});
for (const state of ['idle', 'loading', 'ready', 'error']) {
  for (const event of ['clear', 'dispose']) {
    test(`transitions: ${event} from ${state} invalidates every late completion`, async t => {
      const page = await setup(t, 45);
      if (state === 'idle') await page.evaluate(() => window.view.clear());
      if (state === 'loading') await deferredRefresh(page);
      if (state === 'error') await page.evaluate(async () => {
        window.failure = { code: 'territory_board_limit_exceeded' };
        await window.view.refresh();
        window.failure = null;
      });
      await page.evaluate(event => window.view[event](), event);
      if (state === 'loading') await finishRefresh(page);
      assert.equal(await page.locator('tbody tr').count(), 0);
      assert.equal(await page.locator('[role=alert]').count(), 0);
      assert.equal(await page.locator('.territory-evidence').count(), event === 'clear' ? 1 : 0);
    });
  }
}
test('transitions: superseded completion during loading, ready, error and idle never changes the screen', async t => {
  const page = await setup(t, 45);
  for (const state of ['loading', 'ready', 'error', 'idle']) {
    if (state !== 'loading') await page.getByRole('button', { name: 'Refresh evidence', exact: true }).click();
    await deferredRefresh(page);
    await page.evaluate(state => {
      window.pending = state === 'loading' ? new Promise(resolve => { window.releaseLatest = resolve; }) : null;
      if (state === 'error') window.failure = { code: 'territory_board_limit_exceeded' };
      window.latest = window.view.refresh();
      if (state === 'idle') window.view.clear();
    }, state);
    if (state !== 'loading') await page.evaluate(() => window.latest);
    const before = await page.locator('.territory-evidence').innerText();
    await finishRefresh(page);
    assert.equal(await page.locator('.territory-evidence').innerText(), before);
    await page.evaluate(async state => {
      window.failure = null;
      if (state === 'loading') { window.releaseLatest(window.payload); await window.latest; }
    }, state);
  }
});

test('transitions: condition and evidence remain usable during loading and refusal', async t => {
  const page = await setup(t, 45);
  await moveTo(page, 2);
  await deferredRefresh(page);
  await page.getByLabel('Evidence view', { exact: true }).selectOption('historical');
  await page.locator('select').first().selectOption('conflicting');
  await finishRefresh(page);
  assert.equal(await firstArea(page), 'Recorded area 0000, TX');
  assert.equal(await page.locator('tbody tr').count(), 20);
  assert.equal(await page.getByLabel('Evidence view', { exact: true }).inputValue(), 'historical');
  await page.evaluate(async () => { window.failure = {code:'territory_board_limit_exceeded'}; await window.view.refresh(); window.failure=null; });
  await page.locator('select').first().selectOption('tight');
  await page.getByLabel('Evidence view', { exact: true }).selectOption('current');
  await page.getByRole('button', {name:'Refresh evidence', exact:true}).click();
  assert.equal(await page.getByRole('status').first().textContent(), 'Showing 0–0 of 0 matching loaded areas / 45 total loaded areas');
  assert.equal(await page.getByLabel('Evidence view', { exact: true }).inputValue(), 'current');
});

test('invariant RetiredLoading: cleared panel refresh cannot start an unowned load', async t => {
  const page = await setup(t, 45);
  await page.evaluate(async () => { window.view.clear(); await window.view.refresh(); });
  assert.equal(await page.evaluate(() => window.calls), 1);
  assert.equal(await page.getByRole('status').count(), 0);
});

test('model bug DisposedOwner: open, dispose, then refresh cannot acquire a second request', async t => {
  const page = await setup(t, 45, true);
  assert.equal(await page.getByRole('status').first().textContent(), 'Loading territory evidence…');
  await page.evaluate(() => { window.view.dispose(); window.retiredRefresh = window.view.refresh(); });
  assert.equal(await page.evaluate(() => window.calls), 1);
  await page.evaluate(async () => { window.release(window.payload); await window.retiredRefresh; });
  assert.equal(await page.locator('.territory-evidence').count(), 0);
});
