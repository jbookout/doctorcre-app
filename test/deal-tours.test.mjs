import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { uiBundle } from '../scripts/ui-bundle.mjs';
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
const ui = await import('data:text/javascript;base64,' + bundle.toString('base64'));
const deal = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const tour = '33333333-3333-4333-8333-333333333333';
const row = {id:tour,deal_id:deal,name:'Demo tour',status:'draft'};
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
function open(client) {
  const dom = new JSDOM('<div id="view"></div>');
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = document.querySelector('#view');
  const panel = ui.mountDealTours(root, {dealId:deal, client});
  return {root,panel,dom};
}
test('TOURS-IN-DEAL lists only the current deal and opens its shortlist, route and packet editor', async () => {
  const {root,panel} = open({library:async () => [row,{...row,id:other,deal_id:other,name:'Other deal'},{...row,id:deal,deal_id:null,name:'Legacy'}],tour:async () => ({...row,stops:[]})});
  await settle();
  assert.match(root.textContent,/Demo tour/); assert.doesNotMatch(root.textContent,/Other deal|Legacy/);
  root.querySelector('[data-open-tour]').click(); await settle();
  assert.equal(new URL(root.querySelector('iframe').getAttribute('src'),'https://fixture.test').searchParams.get('tour'),tour);
  root.querySelector('[data-back-tours]').click(); await settle();
  assert.equal(root.querySelector('iframe'),null);
  root.querySelector('[data-start-tour]').click(); await settle();
  assert.equal(new URL(root.querySelector('iframe').getAttribute('src'),'https://fixture.test').searchParams.get('deal'),deal);
  assert.equal(new URL(root.querySelector('iframe').getAttribute('src'),'https://fixture.test').searchParams.has('tour'),false);
  panel.dispose();
});
test('empty, unavailable and retry are truthful without error dumps', async () => {
  let fail = false;
  const {root,panel} = open({library:async () => {if(fail) throw new Error('SQL secret'); return [];}});
  await settle(); assert.match(root.textContent,/No tours for this deal/);
  fail = true; await panel.refresh(); await settle();
  assert.match(root.textContent,/Tours unavailable/); assert.doesNotMatch(root.textContent,/SQL secret/);
  fail = false; root.querySelector('[data-refresh-tours]').click(); await settle();
  assert.match(root.textContent,/No tours for this deal/); panel.dispose();
});
test('inaccessible, malformed and other-deal detail all show not available', async () => {
  for (const result of [null,{...row,deal_id:other,stops:[]},{...row,stops:'bad'}]) {
    const {root,panel} = open({library:async () => [row],tour:async () => {if(!result) throw new Error('not_found SQL'); return result;}});
    await settle(); root.querySelector('[data-open-tour]').click(); await settle();
    assert.match(root.textContent,/Tour not available/); assert.equal(root.querySelector('[data-edit-tour]'),null); panel.dispose();
  }
});
test('refresh and disposal fence stale detail and library reads', async () => {
  let resolve;
  const {root,panel} = open({library:async () => [row],tour:() => new Promise(done => {resolve=done;})});
  await settle(); root.querySelector('[data-open-tour]').click(); await settle();
  await panel.refresh(); resolve({...row,stops:[{property_name:'Stale property'}]}); await settle();
  assert.doesNotMatch(root.textContent,/Stale property/); panel.dispose();
  let finish;
  const next = open({library:() => new Promise(done => {finish=done;})});
  next.panel.dispose(); finish([row]); await settle(); assert.equal(next.root.textContent,'');
});
test('session invalidation clears visible names and discards an in-flight read', async () => {
  let finish;
  const {root,panel,dom} = open({library:async () => [row],tour:() => new Promise(done => {finish=done;})});
  await settle(); root.querySelector('[data-open-tour]').click(); await settle();
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  finish({...row,stops:[]}); await settle();
  assert.match(root.textContent,/Tours unavailable/); assert.doesNotMatch(root.textContent,/Demo tour/); panel.dispose();
});

test('Opening to Open ignores an earlier tour reply and Open to List returns without leaving the workspace', async () => {
  const replies = new Map();
  const {root,panel} = open({library:async () => [row,{...row,id:other}],tour:id => new Promise(resolve => replies.set(id,resolve))});
  await settle();
  root.querySelectorAll('[data-open-tour]')[0].click();
  root.querySelectorAll('[data-open-tour]')[1].click();
  replies.get(other)({...row,id:other,stops:[]}); await settle();
  replies.get(tour)({...row,stops:[]}); await settle();
  assert.ok(root.querySelector('iframe').src.includes(other));
  await panel.refresh();
  assert.ok(root.querySelector('iframe').src.includes(other));
  root.querySelector('[data-back-tours]').click(); await settle();
  assert.equal(Boolean(root.querySelector('iframe')),false); panel.dispose();
});

test('NotAvailable to Opening retries the same tour and ignores frame messages after disposal', async () => {
  let failed = true;
  const {root,panel,dom} = open({library:async () => [row],tour:async () => {if(failed) throw Error('not_found'); return {...row,stops:[]};}});
  await settle(); root.querySelector('[data-open-tour]').click(); await settle();
  failed = false; [...root.querySelectorAll('button')].find(button => button.textContent === 'Retry tour').click(); await settle();
  const source = root.querySelector('iframe').contentWindow;
  panel.dispose();
  dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source,data:{type:'deal-tour-opened',id:tour}}));
  assert.equal(root.textContent,'');
});

test('Creating to Unavailable clears the frame when the session changes', async () => {
  const {root,panel,dom} = open({library:async () => []});
  await settle(); root.querySelector('[data-start-tour]').click(); await settle();
  assert.ok(root.querySelector('iframe'));
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  assert.equal(Boolean(root.querySelector('iframe')),false);
  assert.match(root.textContent,/Tours unavailable/); panel.dispose();
});
