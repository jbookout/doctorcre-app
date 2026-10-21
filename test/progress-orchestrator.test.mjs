import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { mountBoard } from '../js/progress-board.js';

const projection = () => ({schema:'doctorcre-orchestrator/v1', observed_at:'2026-10-21T19:00:00Z',
  sources:{queue:{state:'observed',checked_at:'2026-10-21T19:00:00Z'},github:{state:'stale',last_success_at:'2026-10-21T18:00:00Z'},portfolio:{state:'observed'}},
  cards:[{id:'search',title:'Find a deal across the portfolio',state:'review',owner:'cx-app2',progress:'Keyboard review is ready',
    changed_at:'2026-10-21T19:00:00Z',area:'DoctorCRE app',prs:['https://github.com/jbookout/doctorcre-app/pull/12']}],history:[]});

test('orchestrator shows plain states and updates the same focused card through return, merge and live', async () => {
  const dom = new JSDOM(readFileSync(new URL('../progress-board.html', import.meta.url),'utf8'), {
    url:'https://app.doctorcre.com/control-room/progress/board/orchestrator',pretendToBeVisual:true});
  let data = projection();
  let offline = false;
  const board = mountBoard({window:dom.window,document:dom.window.document,now:()=>new Date('2026-10-21T19:01:00Z'),
    client:{readProgressBoard:async()=>{if(offline) throw new Error('offline'); return {snapshot:{version:1,snapshot_json:{tasks:{},orchestrator:data}}};}}});
  try {
    await board.refresh();
    const doc = dom.window.document;
    assert.match(doc.querySelector('#pipeline-title').textContent,/Orchestrator/);
    assert.equal(doc.querySelectorAll('[data-orchestrator-stage]').length,8);
    const card = doc.querySelector('[data-orchestrator-card="search"]');
    assert.match(card.textContent,/Find a deal.*cx-app2.*Keyboard review/s);
    const link = card.querySelector('a'); link.focus();
    for(const [state,label] of [['fixing','Sent back for fixes'],['merging','Merging'],['merged','Merged / awaiting release']]) {
      data.cards[0].state=state;
      await board.refresh();
      assert.equal(doc.querySelector('[data-orchestrator-card="search"]'),card);
      assert.equal(doc.activeElement,link);
      assert.match(card.textContent,new RegExp(label));
    }
    data.history.push({...data.cards.pop(),state:'live'});
    await board.refresh();
    assert.equal(doc.querySelector('[data-orchestrator-card="search"]'),card);
    assert.match(doc.querySelector('[data-orchestrator-status]').textContent,/stale/i);
    offline=true; await board.refresh();
    assert.ok(card.isConnected);
    assert.match(doc.querySelector('[data-orchestrator-status]').textContent,/offline|unavailable/i);
  } finally {board.dispose();dom.window.close();}
});

test('disposing the orchestrator aborts its pending published read', async () => {
  const dom=new JSDOM(readFileSync(new URL('../progress-board.html',import.meta.url),'utf8'),{
    url:'https://app.doctorcre.com/control-room/progress/board/orchestrator',pretendToBeVisual:true});
  let signal;
  const board=mountBoard({window:dom.window,document:dom.window.document,client:{readProgressBoard:(_args,options)=>new Promise((_resolve,reject)=>{
    signal=options.signal;signal.addEventListener('abort',()=>reject(new Error('aborted')));
  })}});
  const pending=board.refresh();board.dispose();
  assert.equal(signal.aborted,true);assert.equal(await pending,false);dom.window.close();
});

test('denied access clears protected observations and a later authorized read remounts them', async () => {
  const dom=new JSDOM(readFileSync(new URL('../progress-board.html',import.meta.url),'utf8'),{
    url:'https://app.doctorcre.com/control-room/progress/board/orchestrator',pretendToBeVisual:true});
  let denied=false;
  const board=mountBoard({window:dom.window,document:dom.window.document,client:{readProgressBoard:async()=>{
    if(denied) throw Object.assign(new Error('sign in'),{status:401});
    return {snapshot:{version:1,snapshot_json:{tasks:{},orchestrator:projection()}}};
  }}});
  try {
    await board.refresh();denied=true;await board.refresh();
    assert.equal(dom.window.document.querySelector('[data-orchestrator-card]'),null);
    denied=false;await board.refresh();assert.ok(dom.window.document.querySelector('[data-orchestrator-card]'));
  }finally{board.dispose();dom.window.close();}
});
