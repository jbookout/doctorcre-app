import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
const root=new URL('../',import.meta.url);
const bundle=await build({entryPoints:[new URL('reports/share.js',root).pathname],external:['/vendor/*'],bundle:true,write:false,format:'iife'});
const html=await readFile(new URL('reports/share.html',root),'utf8');
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setTimeout(r,0));};
let cookie='A';
const sharedStorage=new Map();
let lock=Promise.resolve();
async function open(t,{token='',state=null,flip=false,sameProjection=false,missingScope=null}={}) {
 const dom=new JSDOM(html,{url:'https://reports.doctorcre.com/share',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const win=dom.window;
 Object.defineProperty(win,'localStorage',{value:{getItem:key=>sharedStorage.get(key)||null,setItem:(key,value)=>sharedStorage.set(key,String(value)),removeItem:key=>sharedStorage.delete(key)}});
 win.history.replaceState(state,'','/share');
 Object.defineProperty(win.navigator,'locks',{value:{request(name,fn){const next=lock.then(fn);lock=next.catch(()=>{});return next;}}});
 win.__CARR_TOUR_TAKE_SHARE_TOKEN__=()=>token;
 let reads=0;
 win.fetch=async(path,init={})=>{
   if(path==='/api/share/exchange'){cookie=JSON.parse(init.body).token;return {ok:true,json:async()=>({ok:true})};}
   const target=cookie;reads++;
   if(path === missingScope) return {ok:false,status:404,json:async()=>({error:'not_found'})};
   if(flip && path==='/api/share/map')cookie='B';
   const data=path==='/api/share/report'?{stops:[{property_ref:`property:public:synthetic_property_${target}`,name:`Private projection ${target}`}]}:path==='/api/share/map'?{points:[]}:{projection_ref:`projection:public:synthetic_projection_${sameProjection?'common':target}`,permission_scopes:[],items:[]};
   return {ok:true,json:async()=>({data})};
 };
 win.eval(bundle.outputFiles[0].text);
 if(token)win.document.querySelector('#open-tour').click();
 await flush();return {win,doc:win.document,get reads(){return reads;}};
}
test('F11: link A reload cannot adopt the host cookie from link B',async t=>{
 cookie='A';const a=await open(t,{token:'A'});
 assert.match(a.doc.querySelector('#report-list').textContent,/Private projection A/);
 const state=a.win.history.state;
 const b=await open(t,{token:'B'});assert.match(b.doc.querySelector('#report-list').textContent,/Private projection B/);
 const refreshed=await open(t,{state});
 assert.doesNotMatch(refreshed.doc.body.textContent,/Private projection B/);
 assert.match(refreshed.doc.querySelector('#status').textContent,/unavailable/);
});
test('F11: mixed delayed cookie contexts clear the entire report',async t=>{
 cookie='A';const a=await open(t,{token:'A',flip:true});
 assert.equal(a.doc.querySelector('#report-list').textContent,'');
 assert.match(a.doc.querySelector('#status').textContent,/unavailable/);
});
test('F11: an unbound token-less tab never adopts another link from a cookie',async t=>{
 cookie='B';const tab=await open(t);
 assert.equal(tab.reads,0);
 assert.doesNotMatch(tab.doc.body.textContent,/Private projection B/);
});

test('F11: two links to the same projection still retain their own link context',async t=>{
 cookie='A';const a=await open(t,{token:'A',sameProjection:true});
 assert.match(a.doc.querySelector('#report-list').textContent,/Private projection A/);
 const state=a.win.history.state;
 await open(t,{token:'B',sameProjection:true});
 const refreshed=await open(t,{state,sameProjection:true});
 assert.equal(refreshed.doc.querySelectorAll('.report-item').length,0);
 assert.match(refreshed.doc.querySelector('#status').textContent,/unavailable/);
});

for (const missingScope of ['/api/share/map','/api/share/report']) test(`F11: verified independent scopes still open when ${missingScope} is excluded`,async t=>{
 cookie='A';const a=await open(t,{token:'A',missingScope});
 assert.match(a.doc.querySelector('#status').textContent,/loaded/);
 assert.doesNotMatch(a.doc.querySelector('#status').textContent,/unavailable/);
});
