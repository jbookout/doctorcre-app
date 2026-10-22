import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {createFixtureClient} from '../js/fixture-client.js';
import {relationshipNetworkFixture} from '../js/relationship-network-fixture.js';
import {routeContract} from '../js/routes.js';

const baseline = process.argv[2];
assert.match(baseline || '', /^[0-9a-f]{40}$/, 'pass the baseline source commit');
const before = Object.fromEntries(['js/home-dashboard-model.js','js/workspace-command-center.js'].map(file =>
  [file, execFileSync('git', ['show', `${baseline}:${file}`], {encoding:'utf8'})]));
const fixture = await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json',import.meta.url))).toString('base64')}`});
const board = await fixture.getBoard();
const deals = Array.from({length:54}, (_, i) => ({...board.deals[0], id:`demo-${i}`, name:`Demo Practice ${i}`, operating_state:'active',phase:'Research',outcome:null,closed_on:null,invoiced_on:null,owner:i%2?'joe':'dell',workspace_kind:i%3?'team':'national_account',account_client_id:i%3?null:'demo-account'}));
const detail = deal => ({deal_id:deal.id,...deal,critical_dates:[{id:`date-${deal.id}`,due_on:'2026-10-23',status:'open'}],next_actions:[{id:`task-${deal.id}`,description:'Demo follow-up',due_on:'2026-10-21',owner:deal.owner,status:'open',hold_until:null}],events:[],thread:[{id:`note-${deal.id}`,kind:'note',text:'Synthetic note. '.repeat(2000)}]});
const agenda = {schema_version:'home-agenda.v1',actor:'joe',deals:deals.map(deal=>({...deal,critical_dates:detail(deal).critical_dates,next_actions:detail(deal).next_actions}))};
const browser = await chromium.launch();
const runs = [];
try {
  for (let i=0;i<5;i++) for (const mode of ['before','after']) {
    const page = await browser.newPage({reducedMotion:'reduce',timezoneId:'America/Chicago'});
    const calls = [], errors = [];
    page.on('pageerror', error=>errors.push(error.message));
    const handlers = {
      'deal-room-board':async()=>{await delay(350);return {...board,deals};},
      'get-deal-room':async args=>{await delay(350);return detail(deals.find(d=>d.id===args.deal));},
      'read-home-agenda':async()=>{await delay(350);return agenda;},
      'lead-board':()=>({leads:[]}),
      'read-invoice-tracker':()=>({schema_version:'invoice-tracker.v1',actor:'joe',entries:[],observed_at:new Date().toISOString()}),
      'incident-board':()=>fixture.incidentBoard(), 'current-work-item':()=>fixture.currentWorkItem(),
      'read-resource-dashboard':()=>fixture.readResourceDashboard(), 'schedule-board':()=>fixture.scheduleBoard(),
      'morning-brief':()=>fixture.morningBrief(), 'today-triage':()=>fixture.todayTriage(),
      'list-feature-switches':()=>fixture.listFeatureSwitches(), 'list-doc-suggestions':args=>fixture.listDocSuggestions(args),
      'notification-feed':()=>({unread_count:0,notifications:[]}), 'list-notifications':()=>({unread_count:0,notifications:[]}),
      'correspondence-readiness':args=>fixture.correspondenceReadiness(args),
    };
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!=='http://localhost')return route.abort();
      if(url.pathname==='/mcp') {
        const rpc=route.request().postDataJSON();calls.push(rpc.params.name);
        assert.ok(handlers[rpc.params.name],rpc.params.name);
        return route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(await handlers[rpc.params.name](rpc.params.arguments))}]}}});
      }
      if(url.pathname==='/api/v1/business/relationships')return route.fulfill({json:relationshipNetworkFixture(new Date().toISOString())});
      if(url.pathname==='/api/system-work/current')return route.fulfill({json:{ok:true,data:await fixture.currentWorkRequests()}});
      if(url.pathname==='/api/system-work/session')return route.fulfill({json:{actor:{slug:'joe',label:'Demo partner'},csrf_token:'synthetic'}});
      if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({status:503,json:{}});
      const file=routeContract.routes[url.pathname]||url.pathname.slice(1);
      try{return route.fulfill({body:mode==='before'&&before[file]?before[file]:await readFile(new URL(`../${file}`,import.meta.url)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404,body:''});}
    });
    const started=performance.now();
    await page.goto('http://localhost/?mode=live');
    await page.locator('#dealAttention[aria-busy="false"]').waitFor();
    const ms=performance.now()-started;
    assert.match(await page.locator('#dealCounts').textContent(),/Active deals: 54/);
    assert.equal(await page.locator('#homeNotice').isVisible(),false);
    assert.deepEqual(errors,[]);
    assert.equal(calls.filter(name=>name==='get-deal-room').length,mode==='before'?54:0);
    assert.equal(calls.filter(name=>name==='read-home-agenda').length,mode==='before'?0:1);
    await page.locator('[data-agenda-show-all]').click();
    const membership=await page.locator('#homeAgenda > a').evaluateAll(rows=>rows.map(row=>row.dataset.homeKey).sort());
    assert.equal(membership.length,108);
    runs.push({mode,ms,detail_reads:mode==='before'?54:0,agenda_reads:mode==='before'?0:1,membership});
    console.log(JSON.stringify({mode,ms}));
    await page.close();
  }
} finally {await browser.close();}
const summary=Object.fromEntries(['before','after'].map(mode=>{
 const values=runs.filter(r=>r.mode===mode).map(r=>r.ms).sort((a,b)=>a-b);
 return [mode,{median_ms:values[2],range_ms:[values[0],values[4]],runs_ms:values}];
}));
for(const run of runs)assert.deepEqual(run.membership,runs[0].membership);
const report={baseline,environment:'Local Chromium, synthetic 54-deal fixture, fixed 350 ms per business read; not production latency',summary,errors:0,membership_count:108,runs:runs.map(({membership,...run})=>run)};
await writeFile(new URL('../test-artifacts/home-agenda-performance.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(summary));
