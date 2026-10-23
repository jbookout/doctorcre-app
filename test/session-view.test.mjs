import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createFixtureClient } from '../js/fixture-client.js';

const root = new URL('../',import.meta.url);
const source = await readFile(new URL('js/conversations.js',root),'utf8');
const bundle = await build({stdin:{contents:source.replace('\nboot();','\nexport { boot, takeList };'),resolveDir:new URL('js/',root).pathname},plugins:[{name:'transport',setup(b){b.onLoad({filter:/private-session\.js$/},()=>({contents:'export const sessionFetch = (...args) => fetch(...args);'}));}}],bundle:true,write:false,format:'iife',globalName:'page',define:{'import.meta.url':JSON.stringify(new URL('js/conversations.js',root).href)}});
const pause = () => new Promise(resolve=>setTimeout(resolve,0));
for (const status of [401,403]) test(`F01: denied Doc Chat pagination (${status}) clears all private titles and fences a late read`,async t=>{
  const dom = new JSDOM(await readFile(new URL('conversations.html',root),'utf8'),{url:'http://localhost/doc-chats?mode=live',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  const win=dom.window;
  win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  win.Response=Response;win.AbortController=AbortController;win.TextEncoder=TextEncoder;
  const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(await readFile(new URL('data/board-seed.json',root))).toString('base64')}`});
  let deny=false, release, held=false;
  win.fetch=async (path,init={})=>{
    if(path==='/api/system-work/session') return Response.json({actor:{slug:'joe'},csrf_token:'synthetic-session-A'});
    if(path==='/mcp') {
      const {name,arguments:args}=JSON.parse(init.body).params;
      if(name==='list-doc-conversations') {
        if(deny) return new Response('{}',{status});
        if(held) return new Promise(resolve=>{release=()=>resolve(Response.json({result:{content:[{type:'text',text:JSON.stringify({conversations:[{id:'private-late',title:'Late private title'}],more:false})}]}}));});
        const data=await fixture.listDocConversations({limit:2});
        return Response.json({result:{content:[{type:'text',text:JSON.stringify(data)}]}});
      }
      return Response.json({result:{content:[{type:'text',text:'{}'}]}});
    }
    return Response.json({});
  };
  win.eval(bundle.outputFiles[0].text);
  await win.page.boot();
  assert.ok(win.page.view.list.rows.length>0);
  const title=win.page.view.list.rows[0].title;
  assert.ok(win.document.body.textContent.includes(title));
  held=true;const late=win.page.takeList();await pause();
  deny=true;await win.page.takeList({cursor:'opaque-cursor'});
  assert.deepEqual([...win.page.view.list.rows],[]);
  assert.equal(win.document.body.textContent.includes(title),false);
  release();await late;
  assert.equal(win.document.body.textContent.includes('Late private title'),false);
});
