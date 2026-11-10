# Lease radar watch proof

Run after a release containing this PR and CARR WATCH slice 4. A coordinator must first supply a due lease and a signed-in browser exposed on loopback CDP. This observation writes no records. It checks existing server evidence, rather than creating a due lease.

Run from the app checkout with the expected merge and due lease as arguments to the command below. Exit 0 means the containing release agrees with the registered reads and one existing Home card opens that lease. Exit 1 means an assertion failed on a containing release. Exit 78 means evidence, session or dependency is unavailable. The existing proof runner owns the total deadline, release ancestry and borrowed-page cleanup.

```sh
node --input-type=module - "$EXPECTED_MERGE" "$DUE_LEASE" <<'JS'
import assert from 'node:assert/strict';
import { prove } from './scripts/prove-activity-attribution-panel.mjs';
import { parseWatch, isWatchSubjectId } from './src/ui/watches/model.ts';
import { watchSummary } from './src/ui/watches/radar-model.ts';
const unavailable = message => Object.assign(Error(message), {exitCode:78});
const [expectedCommit, lease] = process.argv.slice(2);
const rpc = async (page, name, args) => {
  let result;
  try {
    result = await page.evaluate(async ({name,args}) => {
      const {createMcpRequests} = await import('/js/mcp-requests.mjs');
      return createMcpRequests()(name,args,{timeoutMs:5000});
    }, {name,args});
  } catch { throw unavailable('Registered read unavailable'); }
  if (!result || result.kind !== 'payload' || result.isError) throw unavailable('Registered read unavailable');
  return result.payload;
};
async function observe(page, origin) {
  if (!isWatchSubjectId(lease)) throw unavailable('Canonical due lease required');
  await page.goto(`${origin}/leases?mode=live&lease=${lease}`);
  try { await page.locator('#leaseDetail[open]').waitFor({timeout:5000}); }
  catch { throw unavailable('Lease or signed-in session unavailable'); }
  const watches=[];
  const direct=parseWatch(await rpc(page,'read-subject-watch-v2',{subject_type:'lease',subject_id:lease}),{subject_type:'lease',subject_id:lease});
  if(direct && direct.state!=='removed')watches.push(direct);
  const link=page.locator('#leaseDetail [data-radar-key="deal"]');
  const deal=await link.count()?new URL(await link.getAttribute('href'),origin).searchParams.get('deal'):null;
  if(deal){
    const watch=parseWatch(await rpc(page,'read-subject-watch-v2',{subject_type:'deal',subject_id:deal}),{subject_type:'deal',subject_id:deal});
    if(watch && watch.state!=='removed')watches.push(watch);
  }
  await page.getByRole('button',{name:'Close lease details'}).click();
  const status=page.locator(`[data-radar-watch="${lease}"]`);
  await page.waitForFunction(({lease}) => {
    const text=document.querySelector(`[data-radar-watch="${lease}"]`)?.textContent;
    return text && !text.startsWith('Reading');
  },{lease});
  assert.equal(await status.textContent(),watchSummary(watches,lease,deal));
  await page.goto(`${origin}/inbox?mode=live`);
  const snapshot=await rpc(page,'read-home-inbox-v5',{});
  if(!snapshot?.ok || !Array.isArray(snapshot.items))throw unavailable('Home read unavailable');
  const cards=snapshot.items.filter(item=>item.source_type==='notification' && item.open_url===`/leases?lease=${lease}`);
  if(!cards.length)throw unavailable('No due lease card evidence; verify slice 4 and seeded lease');
  assert.equal(cards.length,1,'One due lease semantic alert');
  const card=cards[0];
  await page.goto(`${origin}/inbox/card/${encodeURIComponent(card.item_id)}?mode=live`);
  const source=page.locator(`[data-inbox-row] .inbox-source[href="/leases?lease=${lease}"]`);
  await source.waitFor();
  assert.equal(await source.count(),1);
  await source.click();
  await page.locator('#leaseDetail[open]').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('lease'),lease);
  return {lease, item_id:card.item_id, assertions:['direct and linked deal policies','one server Home card','exact lease opens']};
}
const result=await prove({origin:'https://app.doctorcre.com',expectedCommit,cdpUrl:'http://127.0.0.1:9222',timeoutMs:30000,observe});
console.log(JSON.stringify(result));process.exitCode=result.exitCode;
JS
```

This proves one seeded scenario. It does not prove scheduled receipt capture, semantic classification or all overlap combinations. Those require CARR slice 4's producer acceptance and scheduled receipt. No successful production observation is claimed by this app PR.
