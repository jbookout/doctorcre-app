import { chromium as proofChromium } from './proof-browser.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';
import { readAppRelease, proofFetch, launchProofBrowser } from './app-release-reader.mjs';
import { requireContainingRelease } from './prove-fact-review-pending-status-view.mjs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const defaultEngine = {
  launch: options => proofChromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] }),
  connectOverCDP: (endpoint, options) => chromium.connectOverCDP(endpoint, options),
};
const unavailable = message => Object.assign(new Error(message), {exitCode:78});
export async function observeNatural(page, origin) {
  await page.goto(new URL('/deals',origin).href);
  const card=page.locator('.kanban-card .card-open:visible').first();
  try { await card.waitFor({state:'visible'}); }
  catch { throw unavailable('No natural deal available'); }
  await card.click();
  await page.locator('#detailUpdateForm').waitFor();
  const history=page.locator('.updates-history > summary');
  if (!await history.count()) throw unavailable('No natural activity available');
  await history.click();
  const button=page.locator('[data-attribution-id]').first();
  if (!await button.count()) throw unavailable('No canonical natural activity available');
  const activityId=await button.getAttribute('data-attribution-id');
  const response=await page.evaluate(async activityId=>{
    const {createActivityAttributionRead}=await import('/js/deal-timeline.js');
    const {parseActivityDealAttribution}=await import('/js/ui-activity-attribution.generated.js');
    return parseActivityDealAttribution(await createActivityAttributionRead()(activityId),activityId);
  },activityId);
  await button.click();
  const panel=page.locator('[aria-label="Activity deal attribution"]');
  await panel.locator('h4').waitFor();
  const expectedHeadings={direct:'Direct deal attribution',source_linked:'Source-linked deal needs review',ambiguous:'Ambiguous deals need review',unresolved:'Deal attribution unresolved',unknown:'Activity attribution unknown',unavailable:'Activity attribution unavailable'};
  if(await panel.locator('h4').textContent()!==expectedHeadings[response.attribution])throw Error('Rendered attribution disagrees with registered read');
  const paragraphs=await panel.locator(':scope > p').allTextContents();
  const expectedParagraphs=[`${response.credited_activity_count} credited activities`,...(response.candidates.length?['Review candidates. These links receive no activity credit.']:[]),`Coverage ${response.coverage}.`];
  if(JSON.stringify(paragraphs)!==JSON.stringify(expectedParagraphs))throw Error('Rendered credit, review label or coverage disagrees');
  const links=await panel.locator('a').evaluateAll(nodes=>nodes.map(n=>({label:n.textContent,href:n.getAttribute('href')})));
  const deals=response.direct?[response.direct]:response.candidates;
  if(JSON.stringify(links)!==JSON.stringify(deals.map(d=>({label:d.label,href:'/deals?deal='+d.deal_id}))))throw Error('Rendered recorded deal links disagree');
  await panel.getByText('Version evidence',{exact:true}).click();
  const evidence=await panel.locator('details').evaluate(node=>({
    summary:node.querySelector('summary')?.textContent,
    activity:Array.from(node.querySelectorAll(':scope > p'),n=>n.textContent),
    deals:Array.from(node.querySelectorAll(':scope > div'),row=>({
      label:row.querySelector('p')?.textContent,
      evidence:Array.from(row.querySelectorAll('li'),n=>n.textContent),
    })),
  }));
  const expectedEvidence={
    summary:'Version evidence',
    activity:[response.activity?`Activity ${response.activity.id}, version ${response.activity.version}. Source ${response.activity.source_ref}. Source version ${response.activity.source_version ?? 'not recorded'}.`:'No activity version available.'],
    deals:deals.map(deal=>({label:`${deal.label}, deal version ${deal.deal_version}.`,evidence:deal.evidence.map(item=>`Activity ${item.activity_id}, version ${item.activity_version}.`)})),
  };
  if(JSON.stringify(evidence)!==JSON.stringify(expectedEvidence))throw Error('Rendered version evidence disagrees');
  return {activity_id:activityId,state:response.state,attribution:response.attribution,credited_activity_count:response.credited_activity_count,assertions:['state','credit','coverage','recorded links','version evidence']};
}
export async function prove({origin,expectedCommit,cdpUrl,timeoutMs=30000,engine=defaultEngine,readRelease,contains=requireContainingRelease,observe=observeNatural}={}) {
  const receipt={status:'insufficient_evidence',exitCode:78};
  let browser,timer,containing=false;
  const pages=[],acquisitions=[];
  const controller=new AbortController();
  const deadline=Date.now()+timeoutMs;
  const remaining=()=>{const value=deadline-Date.now();if(value<=0 || controller.signal.aborted)throw unavailable('Total proof deadline exceeded');return value;};
  const read=readRelease || (async()=>readAppRelease(origin,async url=>{
    const response=await proofFetch(url,{signal:controller.signal,cache:'no-store'});
    return {type:response.headers.get('content-type')||'',body:await response.arrayBuffer().then(b=>Buffer.from(b))};
  }));
  const work=async()=>{
    if(!/^[a-f0-9]{40}$/.test(expectedCommit||'') || /^0+$/.test(expectedCommit))throw unavailable('Expected merge commit required');
    const url=new URL(origin);
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw unavailable('Expected an origin');
    receipt.release=await read();remaining();
    await contains(expectedCommit,receipt.release.source_commit,{signal:controller.signal});remaining();containing=true;
    let page;
    try {
      if(cdpUrl){
        const endpoint=new URL(cdpUrl);
        if(!['http:','ws:'].includes(endpoint.protocol) || !['localhost','127.0.0.1'].includes(endpoint.hostname) || endpoint.username || endpoint.password)throw unavailable('Loopback CDP endpoint required');
      }
      if(cdpUrl){
        const connection=engine.connectOverCDP(cdpUrl,{timeout:remaining()}).then(async acquired=>{
          if(controller.signal.aborted){await acquired.close();throw unavailable('Total proof deadline exceeded');}
          return acquired;
        });
        acquisitions.push(connection);
        browser=await connection;
      }else browser=await launchProofBrowser(engine,{headless:true,timeout:remaining()},{signal:controller.signal});
      const context=cdpUrl?browser.contexts()[0]:browser;
      if(!context)throw unavailable('Existing signed-in context unavailable');
      const acquisition=context.newPage().then(async acquired=>{
        if(controller.signal.aborted){await acquired.close();throw unavailable('Total proof deadline exceeded');}
        if(cdpUrl)pages.push(acquired);
        return acquired;
      });
      acquisitions.push(acquisition);
      page=await acquisition;
      remaining();
    }catch(error){throw unavailable(`Browser session unavailable: ${error.message}`);}
    if(!cdpUrl && observe===observeNatural)throw unavailable('Existing signed-in browser session required');
    receipt.natural=await observe(page,origin);remaining();
    receipt.after=await read();remaining();
    if(receipt.release.source_commit!==receipt.after.source_commit)throw unavailable('Release changed during proof');
    return {...receipt,status:'passed',exitCode:0};
  };
  try {
    return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>{const error=unavailable('Total proof deadline exceeded');controller.abort(error);reject(error);},timeoutMs);})]);
  }catch(error){return {...receipt,status:containing && error.exitCode!==78?'failed':'insufficient_evidence',exitCode:containing && error.exitCode!==78?1:78,error:error.message};}
  finally{
    clearTimeout(timer);controller.abort();
    await Promise.allSettled(acquisitions);
    try{await Promise.all(pages.map(page=>page.close()));}
    finally{await browser?.close();}
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const {values}=parseArgs({options:{origin:{type:'string'},'expected-commit':{type:'string'},'cdp-url':{type:'string'},'timeout-ms':{type:'string',default:'30000'}}});
    const timeoutMs=Number(values['timeout-ms']);
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw unavailable('Deadline must be 1 to 30000 milliseconds');
    const result=await prove({origin:values.origin,expectedCommit:values['expected-commit'],cdpUrl:values['cdp-url'],timeoutMs});
    console.log(JSON.stringify(result));process.exitCode=result.exitCode;
  }catch(error){console.log(JSON.stringify({status:'insufficient_evidence',error:error.message}));process.exitCode=78;}
}
