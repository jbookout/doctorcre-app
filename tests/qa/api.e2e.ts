import { expect } from 'e2e';
import { z } from 'zod';
import { test, rpc, seedFixture, baseUrl, Board, Deal, Feed, Invoices, LeadWorkspace, Mutation, Refusal, Viewers, type FixtureVariant, QA_NAMESPACE } from './support.ts';

const stateVariants = ['empty', 'large'] satisfies FixtureVariant[];
const Census = z.object({
  items: z.array(z.object({kind:z.string(),id:z.string()})),
  coverage: z.array(z.object({kind:z.string(),state:z.enum(['complete','partial','unavailable']),count_total:z.number().int().nonnegative().nullable()})),
  next_cursor: z.string().nullable(),
  census_complete: z.boolean(),
});

test('signed-out API refuses reads and writes and preserves document return path', async ({ app }) => {
  const origin = baseUrl(app);
  const bare = (path: string, init?: RequestInit) => fetch(new URL(path, origin), init);
  const read = await rpc(bare, 'deal-room-board');
  expect(read.response.status).toBe(401);
  const write = await rpc(bare, 'patch-deal-field', {deal:'qa-deal-1',field:'owner',value:'dell',idempotency_key:'signed-out-key'});
  expect(write.response.status).toBe(401);
  const page = await bare('/invoices?mode=live&scope=mine', {redirect:'manual'});
  expect(page.status).toBe(302);
  expect(new URL(z.string().parse(page.headers.get('location')), origin).searchParams.get('return_to')).toBe('/invoices?mode=live&scope=mine');
});

for (const viewer of Viewers) {
  test(`${viewer} signed-in HTTP caller sees server identity and versioned projections`, {session:viewer}, async ({ api }) => {
    expect((await api('/api/test/identity')).status).toBe(200);
    const board = await rpc(api, 'deal-room-board', {actor:viewer==='joe'?'dell':'joe'});
    expect(board.response.status).toBe(200);
    expect(board.response.headers.get('content-type')).toContain('application/json');
    const parsed = expect(board.payload).toMatchSchema(Board);
    expect(parsed.actor).toBe(viewer);
    expect(parsed.deals.some(row=>row.owner==='joe')).toBe(true);
    expect(parsed.deals.some(row=>row.owner==='dell')).toBe(true);
    const leads=LeadWorkspace.parse((await rpc(api,'lead-board',{workspace:'leads'})).payload);
    expect(leads.leads.length).toBeGreaterThan(0);
    const invoices=Invoices.parse((await rpc(api,'read-invoice-tracker')).payload);
    expect(invoices.actor).toBe(viewer);
    expect((await api('/pipeline/changes')).status).toBe(200);
  });
}

test('Joe hands a deal to Dell through live MCP; replay, conflict, and namespace isolation stay distinguishable', {session:'joe'}, async ({ app, browser, api }) => {
  const namespace=`${QA_NAMESPACE}-handoff`;
  const origin=baseUrl(app);
  const joe=await seedFixture(origin,namespace,'joe','realistic',true);
  await browser.setCookies([joe.cookie]);
  const dell=await seedFixture(origin,namespace,'dell');
  const dellApi=(path:string,init?:RequestInit)=>fetch(new URL(path,origin),{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),cookie:`${dell.cookie.name}=${dell.cookie.value}`}});
  const args={deal:'qa-deal-1',field:'owner',value:'dell',base_event_id:null,idempotency_key:'qa-team-handoff'};
  const first=await rpc(api,'patch-deal-field',args);
  expect(Mutation.parse(first.payload).ok).toBe(true);
  const replay=await rpc(api,'patch-deal-field',args);
  expect(replay.payload).toEqual(first.payload);
  await expect.poll(async()=> Deal.parse((await rpc(dellApi,'get-deal-room',{deal:'qa-deal-1'})).payload).owner).toBe('dell');
  const stale=await rpc(api,'patch-deal-field',{...args,value:'joe',idempotency_key:'qa-stale-handoff'});
  expect(stale.refused).toBe(true);
  expect(Refusal.parse(stale.payload).error).toBe('version_conflict');
  const other=await seedFixture(origin,`${QA_NAMESPACE}-isolated`,'joe');
  const otherApi=(path:string,init?:RequestInit)=>fetch(new URL(path,origin),{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),cookie:`${other.cookie.name}=${other.cookie.value}`}});
  expect(Deal.parse((await rpc(otherApi,'get-deal-room',{deal:'qa-deal-1'})).payload).owner).toBe('joe');
  const feed=Feed.parse(await (await dellApi('/pipeline/changes')).json());
  expect(feed.events).toHaveLength(1);
    expect(feed.events.map(event=>event.actor)).toEqual(['joe']);
});

test('fixture variants expose empty and large collections through the HTTP seam', async ({ app, browser, api }) => {
  for (const variant of stateVariants) {
    const seeded=await seedFixture(baseUrl(app),`${QA_NAMESPACE}-${variant}`,'joe',variant,true);
    await browser.setCookies([seeded.cookie]);
    expect(Board.parse((await rpc(api,'deal-room-board')).payload).deals).toHaveLength(seeded.counts.deals);
    expect(LeadWorkspace.parse((await rpc(api,'lead-board',{workspace:'leads'})).payload).leads).toHaveLength(seeded.counts.leads);
    expect(Invoices.parse((await rpc(api,'read-invoice-tracker')).payload).entries).toHaveLength(seeded.counts.invoices);
    expect(seeded.counts.deals).toBe(variant==='empty'?0:160);
  }
});

test('final fixture HTTP census counts all pages and refuses unsupported creation without changing records', {session:'joe'}, async ({app,browser,api}) => {
  const seeded=await seedFixture(baseUrl(app),`${QA_NAMESPACE}-final-contract`,'joe','realistic',true);
  await browser.setCookies([seeded.cookie]);
  const pages: z.infer<typeof Census>[]=[];
  let cursor: string | null=null;
  do {
    const response=await api(`/api/v1/work-inventory${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`);
    expect(response.status).toBe(200);
    const body: unknown=await response.json();
    const page=Census.parse(body);
    pages.push(page);
    cursor=page.next_cursor;
    expect(pages.length).toBeLessThanOrEqual(2);
  } while(cursor);
  expect(pages).toHaveLength(2);
  const items=pages.flatMap(page=>page.items);
  for(const page of pages)for(const leg of page.coverage) {
    if(leg.state==='complete')expect(leg.count_total).toBe(new Set(items.filter(item=>item.kind===leg.kind).map(item=>item.id)).size);
    else expect(leg.count_total).toBe(null);
  }
  expect(pages.every(page=>!page.census_complete)).toBe(true);
  const statusBody: unknown=await (await api('/api/v1/work-inventory?kinds=work_request')).json();
  const status=Census.parse(statusBody);
  expect(status.census_complete).toBe(true);
  expect(status.coverage.map(leg=>leg.count_total)).toEqual([8]);

  const before=Board.parse((await rpc(api,'deal-room-board')).payload);
  const refused=await rpc(api,'new-deal',{name:'Demo Unsupported Creation',client:'C-DEMO',idempotency_key:'final-fixture-creation'});
  expect(refused.response.status).toBe(200);
  expect(refused.refused).toBe(true);
  expect(Refusal.parse(refused.payload).error).toBe('fixture_operation_unavailable');
  expect(Board.parse((await rpc(api,'deal-room-board')).payload).deals).toEqual(before.deals);
  const feedBody: unknown=await (await api('/pipeline/changes')).json();
  expect(Feed.parse(feedBody).events).toHaveLength(0);
});

test('native agent calls project seed and screenshot evidence tools', {session:'joe',agent:'joe'}, async ({app,agent,api,browser}) => {
  for (const variant of stateVariants) {
    await agent.act(`Use the seedFixtureAccount project tool with variant ${variant}, namespace {namespace}, and viewer joe. Complete once the tool confirms the seed.`, {params:{namespace:QA_NAMESPACE}});
    expect(Board.parse((await rpc(api,'deal-room-board')).payload).deals).toHaveLength(variant==='large'?160:0);
    await app.open('/?mode=live');
    await expect(browser.locator('#dealCounts')).toContainText(`Active Deals: ${variant==='large'?160:0}`);
    await agent.act('Use the captureEvidence project tool to save a screenshot of the current Home page. Complete once the tool returns an evidence reference.');
    expect(Board.parse((await rpc(api,'deal-room-board')).payload).deals).toHaveLength(variant==='large'?160:0);
  }
});
