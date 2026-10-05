import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {handleDoctorcreRequest} from '../src/worker.js';
import {workspace,detail} from './leads-workspace-fixture.mjs';

export async function routeLeads(page,{getBoard=workspace,onRead=()=>{},onWrite=()=>{}}={}) {
 const types={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.geojson':'application/geo+json'};
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!=='http://localhost')return route.abort();
  const env={APP_ENV:'staging',CARR:{fetch:async request=>{
   const path=new URL(request.url).pathname;
   if(path==='/mcp'){
    const p=(await request.json()).params;let value={ok:true};
    if(p.name==='deal-room-board')value={actor:'example-partner',deals:[]};
    else if(p.name==='lead-board'){onRead();const board=getBoard();value={...board,...(p.arguments.lead_id?{detail:detail(board.leads.find(l=>l.id===p.arguments.lead_id))}:{})}}else onWrite(p);
    return Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify(value)}]}});
   }
   if(path.startsWith('/api/'))return Response.json({actor:{slug:'example-partner'},csrf_token:'synthetic-test-token',items:[],counts:{}});
   return new Response('synthetic auth gate');
  }},ASSETS:{fetch:async request=>{
   const path=new URL(request.url).pathname.slice(1);
   try{return new Response(await readFile(new URL('../'+path,import.meta.url)),{headers:{'content-type':types[extname(path)]||'application/octet-stream'}})}catch{return new Response('',{status:404})}
  }}};
  const response=await handleDoctorcreRequest(new Request(req.url(),{method:req.method(),...(req.postData()?{body:req.postData()}:{}),headers:req.headers()}),env);
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
 });
}
