import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as model from '../js/progress-board-model.js';
import { mountBoard } from '../js/progress-board.js';

const tasks = {
  running: {title:'Build the synthetic export',status:'running',updated_at:'2026-10-01T12:00:00Z'},
  unconfirmed: {title:'Check the synthetic task',status:'running'},
  review: {title:'Review the synthetic export',status:'review'},
  merged: {title:'Publish the synthetic export',status:'done',pr:12,pr_phase:'Merged'},
  live: {title:'Use the synthetic export',status:'done'},
  recorded: {title:'Recorded synthetic work',status:'done',stage:'recorded'},
  blocked: {title:'Resolve the synthetic dependency',status:'blocked'},
  failed: {title:'Repair the synthetic check',status:'failed'},
  queued: {title:'Prepare the synthetic export',status:'queued'},
};
const at = new Date('2026-10-01T12:00:00Z');
const read = {snapshot:{board_id:'demo',version:1,snapshot_json:{title:'Synthetic delivery',tasks}},questions:[]};

test('work views separate current work, completed records, attention and the queue by exact membership', () => {
  const cards = model.boardView(read,at).cards;
  const ids = view => model.cardsForView(cards,view).map(card=>card.id).sort();
  assert.deepEqual(ids('active'),['merged','review','running','unconfirmed']);
  assert.deepEqual(ids('completed'),['live','recorded']);
  assert.deepEqual(ids('attention'),['blocked','failed','unconfirmed']);
  assert.deepEqual(ids('queue'),['queued']);
  assert.deepEqual(ids('history'),['blocked','failed','live','merged','queued','recorded','review','running','unconfirmed']);
});

async function mount() {
  const page = await readFile(new URL('../progress-board.html',import.meta.url),'utf8');
  const dom = new JSDOM(page,{url:'https://app.test/control-room/progress/board/demo'});
  const {window} = dom;
  window.scrollTo = () => {};
  let snapshot = structuredClone(read);
  let directoryFailure = null;
  for (let i=0;i<100;i++) snapshot.snapshot.snapshot_json.tasks[`queue-${i}`] = {title:`Synthetic queued outcome ${i}`,status:'queued'};
  const board = mountBoard({window,document:window.document,client:{readProgressBoard:async()=>snapshot,listProgressBoards:async()=>{if(directoryFailure)throw directoryFailure;return {schema:'progress-board-directory.v1',boards:[]};}},storage:null,
    now:()=>at,setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{}});
  await board.refresh();
  return {board,doc:window.document,window,setRead:value=>{snapshot=value;},denyDirectory:()=>{directoryFailure=Object.assign(new Error("Synthetic access denied"),{status:403});}};
}

test('standalone board selects views and caps each lane without changing exact totals',async()=>{
  const {board,doc}=await mount();
  const ids=()=>[...doc.querySelectorAll('#board-stages .board-card')].map(node=>node.dataset.cardId).sort();
  const choose=id=>doc.querySelector(`[data-work-view="${id}"]`).click();
  assert.deepEqual(ids(),['merged','review','running','unconfirmed']);
  assert.equal(doc.querySelector('[data-work-view="active"]').getAttribute('aria-pressed'),'true');
  choose('completed'); assert.deepEqual(ids(),['live','recorded']);
  choose('attention'); assert.deepEqual(ids(),['blocked','failed','unconfirmed']);
  choose('queue'); assert.equal(ids().length,20);
  assert.equal(doc.querySelector('.stage-count').textContent,'101');
  doc.querySelector('.lane-toggle').click(); assert.equal(ids().length,101);
  assert.equal(doc.querySelector('.lane-toggle').textContent,'Show fewer');
  choose('active'); choose('queue'); assert.equal(ids().length,101,'each view retains its expanded lanes');
  await board.refresh(); assert.equal(ids().length,101,'refresh retains lane expansion');
  doc.querySelector('.lane-toggle').click(); assert.equal(ids().length,20);
  assert.equal(doc.activeElement,doc.querySelector('.lane-toggle'),'collapse returns focus to its reachable control');
  choose('history'); assert.equal(ids().length,28,'history retains all status memberships within lane caps');
  assert.equal(doc.querySelector('#system-work-panel').hidden,true,'project history does not expose an unconnected system-work form');
  assert.equal(doc.querySelector('.repos-panel').hidden,true,'project history does not expose an empty repository directory');
  board.dispose();
});

for (const outcome of ['denied directory','unpublished snapshot']) test(`work view counts clear with a ${outcome}`,async()=>{
  const {board,doc,setRead,denyDirectory}=await mount();
  assert.match(doc.querySelector('.work-view-menu').textContent,/Queue · 101/);
  if(outcome==='denied directory') denyDirectory();
  else setRead({snapshot:null,questions:[]});
  await board.refresh();
  const menu=doc.querySelector('.work-view-menu');
  assert.ok(!menu || menu.hidden,'protected navigation is hidden');
  assert.ok(!menu || !menu.textContent.includes('·'),'protected counts are cleared');
  assert.equal(doc.querySelector('.progress-main').classList.contains('has-work-views'),false);
  board.dispose();
});
