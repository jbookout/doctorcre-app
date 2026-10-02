import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountSystemWorkBoard} from '../js/system-work-board.js';
for (const library of [false,true]) for(const available of [false,true]) test(`finding 11: ${available?'available':'unavailable'} source navigation (${library?'Live Library':'Unfinished'})`,async()=>{
 const dom=new JSDOM(readFileSync(new URL('../progress-board.html',import.meta.url),'utf8'),{url:'http://localhost/control-room/progress'});
 const prior={document:globalThis.document,FormData:globalThis.FormData};Object.assign(globalThis,{document:dom.window.document,FormData:dom.window.FormData});
 try {
  const item={id:'synthetic',kind:'portfolio_node',source:'ops.portfolio_node',title:'Synthetic portfolio',state:library?'complete':'open',completed:library,age:1,last_activity_at:'2026-10-02T12:00:00Z',link:available?'/system-work.html?work_request=WR-000001':null,navigation:available?{state:'available',link:'/system-work.html?work_request=WR-000001'}:{state:'unavailable',link:null,reason:'owning_workflow_has_no_supported_record_navigation'},available_triage_actions:[]};
  const client={unfinishedWork:async a=>({schema:'unfinished-work.v1',items:a.live_library===library?[item]:[],coverage:[],census_complete:true,next_cursor:null})};
  mountSystemWorkBoard({client,onPipeline:()=>{}});
  const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};await settle();
  if(library){dom.window.document.querySelector('#live-library').click();await settle();}
  const actions=dom.window.document.querySelector('.work-card .work-actions');assert.ok(actions);
  if(available){
   for(const link of dom.window.document.querySelectorAll('.work-card a')) assert.equal(link.getAttribute('href'),'/system-work.html?work_request=WR-000001','supported links must retain their owning record identity');
   assert.ok(actions.querySelector('a'));
  }else{
   assert.equal(dom.window.document.querySelector('.work-card a'),null,'unavailable source navigation must not fabricate a link');
   assert.match(actions.textContent,/unavailable/i,'unavailable source navigation must remain visible');
  }
 }finally{Object.assign(globalThis,prior);dom.window.close();}
});
