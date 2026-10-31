import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../js/live-client.js';
import { createLeadBoardClient } from '../js/leads-client.js';

const empty = { ok: true, contract: 'practice-origination.v1', cards: [], coverage: [], next_cursor: null, outreach_started: false };
for (const create of [createLiveClient, createLeadBoardClient]) test(`${create.name} reads paged origination evidence without writes`, async () => {
  const calls = [];
  const client = create({ docContext: false, fetchImpl: async (path, init) => {
    calls.push({path, init});
    return {ok:true, json:async()=>({result:{content:[{type:'text',text:JSON.stringify(empty)}]}})};
  }});
  assert.deepEqual(await client.listPracticeOrigination({limit:25,before_id:'42'}), empty);
  assert.equal(calls[0].path, '/mcp');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0].init.body).params, {name:'list-practice-origination',arguments:{limit:25,before_id:'42'}});
});

test('fixture provides dated synthetic routes and explicit source coverage with pagination', async () => {
  const {createFixtureClient} = await import('../js/fixture-client.js');
  const {readFile} = await import('node:fs/promises');
  const seed = await readFile(new URL('../data/board-seed.json', import.meta.url));
  const client = await createFixtureClient({docContext:false,seedUrl:`data:application/json;base64,${seed.toString('base64')}`});
  const first = await client.listPracticeOrigination({limit:2});
  assert.equal(first.contract, 'practice-origination.v1');
  assert.equal(first.cards.length, 2);
  assert.equal(first.cards[0].why_now, 'NPI enumerated on 2026-10-26');
  assert.equal(first.next_cursor, '5');
  const rest = await client.listPracticeOrigination({before_id:first.next_cursor});
  const rows = [...first.cards, ...rest.cards];
  assert.deepEqual([...new Set(rows.map(c=>c.route))].sort(), ['identity_review','relationship_follow_up','research']);
  assert.ok(rows.every(c=>c.name.startsWith('Demo ') && c.evidence_date && c.source_url.startsWith('https://')));
  assert.equal(first.coverage.find(c=>c.source==='nppes').status, 'available');
  assert.equal(first.coverage.find(c=>c.source==='formation-fl').status, 'unavailable');
  assert.equal(first.coverage.find(c=>c.source==='recorder-other').status, 'uncovered');
  assert.equal(rest.outreach_started, false);
  first.cards[0].name = 'Changed';
  assert.notEqual((await client.listPracticeOrigination()).cards[0].name, 'Changed');
});

test('rendered reasons preserve date meaning, relationship routing, review holds and coverage', async t => {
  const {JSDOM} = await import('jsdom');
  const {mountContactReasons} = await import('../js/contact-reasons.js');
  const {practiceOriginationFixture} = await import('../js/practice-origination-fixture.js');
  const dom = new JSDOM('<section id="reasons"></section>', {url:'http://localhost/leads'});
  t.after(()=>dom.window.close());
  const host = dom.window.document.getElementById('reasons');
  const view = mountContactReasons({host,window:dom.window,client:{listPracticeOrigination:async()=>practiceOriginationFixture()}});
  t.after(()=>view.dispose());
  await view.refresh();
  host.querySelector('[data-show-reasons]').click();
  assert.equal(host.querySelectorAll('.work-card').length,6);
  assert.equal(host.querySelector('a[href="/clients?record=demo-client"]').textContent,'Follow up with DEMO-CLIENT');
  const review = [...host.querySelectorAll('article')].find(c=>c.textContent.includes('Needs review'));
  assert.match(review.textContent,/Demo Similar Practice/);
  assert.equal(review.querySelectorAll('button').length,0);
  assert.equal(review.querySelectorAll('a').length,1);
  assert.match(host.textContent,/Practice registered in NPPES/);
  assert.match(host.textContent,/Medicare enrollment evidence corrected/);
  assert.match(host.textContent,/Publication date/);
  assert.match(host.textContent,/Oct 26, 2026/);
  assert.match(host.textContent,/Alabama formations · Not yet covered/);
  assert.match(host.textContent,/NPPES · Covered/);
  assert.equal(host.querySelectorAll('a[target="_blank"]').length,6);
  assert.equal(host.querySelectorAll('button').length,0);
});

test('Home caps new research reasons at two and links each to Leads', async t => {
  const {JSDOM} = await import('jsdom');
  const {mountContactReasons} = await import('../js/contact-reasons.js');
  const {practiceOriginationFixture} = await import('../js/practice-origination-fixture.js');
  const dom = new JSDOM('<section></section>', {url:'http://localhost/'});
  t.after(()=>dom.window.close());
  const host = dom.window.document.querySelector('section');
  const view = mountContactReasons({host,window:dom.window,home:true,client:{listPracticeOrigination:async()=>practiceOriginationFixture()}});
  t.after(()=>view.dispose());
  await view.refresh();
  assert.equal(host.querySelectorAll('article').length,2);
  assert.equal(host.querySelectorAll('h3 a[href="/leads#contactReasons"]').length,2);
  assert.doesNotMatch(host.textContent,/Follow up with|Needs review/);
});

test('failed reads stay distinct from empty results, retry recovers, and session retirement rejects late data', async t => {
  const {JSDOM} = await import('jsdom');
  const {mountContactReasons} = await import('../js/contact-reasons.js');
  const {practiceOriginationFixture} = await import('../js/practice-origination-fixture.js');
  const dom = new JSDOM('<section></section>', {url:'http://localhost/leads'});
  t.after(()=>dom.window.close());
  const host = dom.window.document.querySelector('section');
  let result = {contract:'wrong'};
  const client = {listPracticeOrigination:async()=>result};
  const view = mountContactReasons({host,window:dom.window,client});
  t.after(()=>view.dispose());
  await view.refresh();
  assert.match(host.textContent,/Contact reasons unavailable/);
  assert.doesNotMatch(host.textContent,/No new reasons/);
  result = practiceOriginationFixture();
  await view.refresh();
  assert.equal(host.querySelectorAll('article').length,2);
  let release;
  client.listPracticeOrigination = ()=>new Promise(resolve=>{release=resolve});
  const pending = view.refresh();
  await Promise.resolve();
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  release(result);
  await pending;
  assert.equal(host.querySelectorAll('article').length,0);
  assert.doesNotMatch(host.textContent,/Demo /);
  assert.match(host.textContent,/Sign in/);
});

test('follow-up identifies the matched client even when its name differs from public evidence', async t => {
  const {JSDOM} = await import('jsdom');
  const {mountContactReasons} = await import('../js/contact-reasons.js');
  const {practiceOriginationFixture} = await import('../js/practice-origination-fixture.js');
  const dom = new JSDOM('<section></section>', {url:'http://localhost/leads'});
  t.after(()=>dom.window.close());
  const host = dom.window.document.querySelector('section');
  const payload = practiceOriginationFixture();
  payload.cards = [payload.cards[1]];
  payload.cards[0].client_refs = ['C-DEMO'];
  const view = mountContactReasons({host,window:dom.window,client:{listPracticeOrigination:async()=>payload}});
  t.after(()=>view.dispose());
  await view.refresh();
  assert.equal(host.querySelector('h3 a').textContent,'Follow up with C-DEMO');
  assert.match(host.textContent,/Demo Client Practice/);
});

test('More reasons pages without duplicates and preserves the focused source on refresh', async t => {
  const {JSDOM} = await import('jsdom');
  const {mountContactReasons} = await import('../js/contact-reasons.js');
  const {practiceOriginationFixture} = await import('../js/practice-origination-fixture.js');
  const dom = new JSDOM('<section></section>', {url:'http://localhost/leads'});
  t.after(()=>dom.window.close());
  const host = dom.window.document.querySelector('section');
  let lastArgs;
  const view = mountContactReasons({host,window:dom.window,client:{listPracticeOrigination:async args=>{
    lastArgs = args;
    return practiceOriginationFixture({...args,limit:2});
  }}});
  t.after(()=>view.dispose());
  await view.refresh();
  assert.equal(host.querySelectorAll('article').length,2);
  host.querySelector('[data-more-reasons]').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(lastArgs.before_id,'5');
  host.querySelector('[data-show-reasons]').click();
  assert.equal(host.querySelectorAll('article').length,4);
  const source = host.querySelector('a[target="_blank"]');
  source.focus();
  await view.refresh();
  assert.equal(dom.window.document.activeElement.href,source.href);
});

 test('Home hides empty results and skips malformed cards', async t => {
  const {JSDOM} = await import('jsdom');
  const {mountContactReasons} = await import('../js/contact-reasons.js');
  const {practiceOriginationFixture} = await import('../js/practice-origination-fixture.js');
  const dom = new JSDOM('<section></section>', {url:'http://localhost/'});
  t.after(()=>dom.window.close());
  const host = dom.window.document.querySelector('section');
  let payload = {...empty};
  const view = mountContactReasons({host,window:dom.window,home:true,client:{listPracticeOrigination:async()=>payload}});
  t.after(()=>view.dispose());
  await view.refresh();
  assert.equal(host.hidden,true);
  payload = practiceOriginationFixture();
  payload.cards.unshift({id:'broken'});
  await view.refresh();
  assert.equal(host.hidden,false);
  assert.equal(host.querySelectorAll('article').length,2);
  assert.doesNotMatch(host.textContent,/unavailable/);
});
