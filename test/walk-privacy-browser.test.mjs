import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerFixture } from '../scripts/fixture-http.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

const require = createRequire(import.meta.url);

test('no-fixture POST admission refuses every registry write and unknown read-like verb', async t => {
  const registry = JSON.parse(readFileSync('test/fixtures/walk-verb-registry.json', 'utf8')).response;
  assert.equal(registry.ok, true);
  assert.equal(registry.names_only, true);
  assert.equal(registry.count, registry.verbs.length);
  const refused = registry.verbs.filter(verb => verb.write === true).map(verb => verb.name);
  assert.ok(refused.includes('read-client-portal'));
  refused.unshift('read-client-portal');
  refused.push('read-invented', 'get-invented', 'list-invented', 'preview-invented', 'search-invented', 'human-actors', 'search-parties');
  const receipts = [];
  const server = await startWorkerFixture({ routes:new Map([['/',{body:'synthetic sink',contentType:'text/html'}]]), env:{CARR:{fetch:async request => {
    if (request.method !== 'GET') receipts.push(request.method);
    return new Response('synthetic sink');
  }}} });
  t.after(() => server.close());
  const directory = temporaryDirectory('doctorcre-walk-read-guard-', t);
  writeFileSync(resolve(directory, 'reads.spec.ts'), `
import { expect } from ${JSON.stringify(require.resolve('@playwright/test'))};
import { test, readOnlyVerbs } from ${JSON.stringify(resolve('tests/walks/privacy.ts'))};
test('no unverified mutation leaves the browser', async ({page}) => {
  await page.goto('/');
  for (const name of ${JSON.stringify(refused)}) {
    expect(await page.evaluate(name => fetch('/mcp', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'tools/call',params:{name,arguments:{}}})}).then(()=>false,()=>true), name), name).toBe(true);
  }
  for (const [method, envelope] of [
    ['PUT', {method:'tools/call',params:{name:'read-home-inbox-v5'}}],
    ['POST', {method:'tools/list',params:{name:'read-home-inbox-v5'}}],
    ['POST', {params:{name:'read-home-inbox-v5'}}],
  ]) expect(await page.evaluate(({method,envelope})=>fetch('/mcp',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope)}).then(()=>false,()=>true),{method,envelope})).toBe(true);
});
test('allowlist contains only recorded registry reads', async ({page}) => {
  const verbs = ${JSON.stringify(registry.verbs)};
  expect(readOnlyVerbs.length).toBeGreaterThan(0);
  expect(new Set(readOnlyVerbs).size).toBe(readOnlyVerbs.length);
  for (const name of readOnlyVerbs) expect(verbs.find(verb => verb.name === name)?.write, name).toBe(false);
  await page.goto('/');
  expect(await page.evaluate(() => fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'tools/call',params:{name:'read-home-inbox-v5',arguments:{}}})}).then(r=>r.status))).toBe(200);
});`);
  const config = resolve(directory, 'playwright.config.ts');
  writeFileSync(config, `export default { testDir: '.', workers: 1, retries: 0, outputDir: './results', use: { baseURL: '${server.origin}', serviceWorkers: 'block' } };`);
  const { stdout } = await promisify(execFile)(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', config, '--reporter=json'], { timeout: 30_000 }).catch(error => {
    assert.deepEqual(receipts, [], 'Refused requests must never reach the server');
    throw error;
  });
  assert.equal(JSON.parse(stdout).stats.expected, 2);
  assert.deepEqual(receipts, ['POST']);
});

test('walk privacy covers consecutive spec files and secondary pages', async t => {
  let writes = 0;
  const server = await startWorkerFixture({ routes:new Map([['/status',{status:429,body:'synthetic',contentType:'text/html'}]]), env:{CARR:{fetch:async request => {
    if (request.method === 'POST') writes++;
    return new Response('synthetic');
  }}} });
  t.after(() => server.close());
  const directory = temporaryDirectory('doctorcre-walk-privacy-', t);
  const spec = `
import { expect } from ${JSON.stringify(require.resolve('@playwright/test'))};
import { test } from ${JSON.stringify(resolve('tests/walks/privacy.ts'))};
test('guards and diagnostics', async ({ page, context }, info) => {
  await page.goto('/status');
  const secondary = await context.newPage();
  await secondary.goto('/status');
  expect(info.annotations.filter(x => x.type === 'http-status' && x.description === 'document 429').length).toBe(2);
  for (const target of [page, secondary]) {
    for (const name of ['complete-one-action', 'reopen-one-action', 'settle-home-inbox', 'unsettle-home-inbox', 'snooze-home-inbox', 'edit-email-draft', 'set-home-waiting', 'clear-home-waiting']) {
      expect(await target.evaluate(name => fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'tools/call', params: { name, arguments: { action_id: '11111111-1111-4111-8111-111111111111', idempotency_key: '11111111-1111-4111-8111-111111111112' } } }) }).then(() => false, () => true), name)).toBe(true);
    }
    expect(await target.evaluate(() => fetch('/write', { method: 'POST' }).then(() => false, () => true))).toBe(true);
  }
});`;
  for (const name of ['first', 'second']) writeFileSync(resolve(directory, `${name}.spec.ts`), spec);
  writeFileSync(resolve(directory, 'third.spec.ts'), `
import { test } from ${JSON.stringify(resolve('tests/walks/privacy.ts'))};
test('redacts private failures', async () => { throw new Error('SYNTHETIC_PRIVATE_BODY'); });`);
  const config = resolve(directory, 'playwright.config.ts');
  writeFileSync(config, `export default { testDir: '.', workers: 1, retries: 0, outputDir: './results', use: { baseURL: '${server.origin}', serviceWorkers: 'block' } };`);
  const result = await promisify(execFile)(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', config, '--reporter=json'], {
    timeout: 30_000, env: { ...process.env, PLAYWRIGHT_NO_COPY_PROMPT: '1' },
  }).then(() => assert.fail('The synthetic privacy failure must remain failed'), error => error);
  const report = JSON.parse(result.stdout);
  assert.equal(report.stats.expected, 2);
  assert.equal(report.stats.unexpected, 1);
  assert.doesNotMatch(result.stdout, /SYNTHETIC_PRIVATE_BODY/);
  assert.equal(writes, 0);
});

test('walk mutation admission requires canonical TEST deal and exact record IDs', async t => {
  let writes = 0;
  const server = await startWorkerFixture({ env:{CARR:{fetch:async request => {
    if (request.method !== 'GET') writes++;
    return new Response('synthetic mutation sink');
  }}} });
  t.after(() => server.close());
  const directory = temporaryDirectory('doctorcre-walk-admission-', t);
  writeFileSync(resolve(directory, 'admission.spec.ts'), `
import { expect } from ${JSON.stringify(require.resolve('@playwright/test'))};
import { test } from ${JSON.stringify(resolve('tests/walks/privacy.ts'))};
import { card } from ${JSON.stringify(resolve('tests/walks/ui.ts'))};
import { fixtureInboxRpc } from ${JSON.stringify(resolve('src/ui/home/fixture.tsx'))};
import { parseSnapshot } from ${JSON.stringify(resolve('src/ui/home/inbox.tsx'))};
async function fixture(context, ordinary = false, missing = false, number = 12) {
  const raw = await fixtureInboxRpc()('read-home-inbox-v5', {});
  const item = raw.items[0];
  item.title = 'TEST WALK ' + number + ' follow-up';
  const snapshot = parseSnapshot({ ...raw, items: missing ? [] : [item] });
  await context.route('**/*', async route => {
    const request = route.request();
    if (request.method() === 'POST' && request.postDataJSON()?.params?.name === 'read-home-inbox-v5') return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(snapshot) }] } } });
    if (request.method() !== 'GET') return route.fallback();
    if (new URL(request.url()).pathname === '/deals') return route.fulfill({ contentType: 'text/html', body: '<button id="listView">List</button><span id="boardStatusLabel">Ready</span><span id="boardAsOf">Updated</span><a class="deal-link" data-open-deal="' + item.deal_id + '">' + (ordinary ? 'Ordinary deal' : 'TEST WALK ' + number + ' deal') + '</a>' });
    return route.fulfill({ contentType: 'text/html', body: '<h1>Welcome home.</h1><div class="inbox-health">Updating</div><main></main><script>fetch("/mcp", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({method:"tools/call",params:{name:"read-home-inbox-v5"}})}).then(r=>r.json()).then(()=>{document.querySelector("main").innerHTML=' + JSON.stringify(missing ? '' : '<article data-inbox-row="' + item.item_id + '"><h3><a>' + item.title + '</a></h3><button>Mark done</button></article>') + ';document.querySelector(".inbox-health").textContent="Up to date"})</script>' });
  });
  return snapshot.items[0] || item;
}
async function send(page, name, args) {
  return page.evaluate(({name,args}) => fetch('/mcp', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'tools/call',params:{name,arguments:{idempotency_key:'11111111-1111-4111-8111-111111111112',...args}}})}).then(r=>r.status,()=>0), {name,args});
}
test('numbered action on ordinary deal skips before mutation', async ({page,context}) => {
  await fixture(context, true);
  await card(page,12);
  throw Error('Ordinary deal was admitted');
});
test('absent TEST fixture skips before mutation', async ({page,context}) => {
  await fixture(context, false, true);
  await card(page,12);
  throw Error('Absent fixture was admitted');
});
test('verified fixture admits exact action only', async ({page,context}) => {
  const item = await fixture(context);
  await card(page,12);
  const args = {items:[{item_id:item.item_id,base_version:item.base_version}],action_id:item.action_id,base_version:item.action_version};
  expect(await send(page,'complete-one-action',{...args,action_id:'11111111-1111-4111-8111-111111111111'})).toBe(0);
  expect(await send(page,'complete-one-action',{...args,items:[{item_id:'ordinary'}]})).toBe(0);
  expect(await send(page,'complete-one-action',{...args,items:[...args.items,{item_id:'ordinary'}]})).toBe(0);
  expect(await send(page,'settle-home-inbox',args)).toBe(0);
  expect(await send(page,'edit-email-draft',{proposal_id:item.source_id})).toBe(0);
  expect(await send(page,'complete-one-action',args)).toBe(200);
  expect(await send(page,'reopen-one-action',{...args,completion_event_id:'11111111-1111-4111-8111-111111111113'})).toBe(200);
  item.deal_id = '11111111-1111-4111-8111-111111111114';
  await send(page,'read-home-inbox-v5',{});
  expect(await send(page,'complete-one-action',args)).toBe(0);
});
test('disposition stays bound to the verified item', async ({page,context}) => {
  const item = await fixture(context,false,false,3);
  await card(page,3);
  expect(await send(page,'settle-home-inbox',{items:[{item_id:'ordinary'}]})).toBe(0);
  expect(await send(page,'settle-home-inbox',{items:[{item_id:item.item_id}]})).toBe(200);
});
test('batch undo stays bound to its admitted batch', async ({page,context}) => {
  const item = await fixture(context,false,false,10);
  await card(page,10);
  const items = [{item_id:item.item_id}];
  const key = '11111111-1111-4111-8111-111111111112';
  expect(await send(page,'settle-home-inbox',{items,reversible:true})).toBe(200);
  expect(await send(page,'settle-home-inbox',{undo_of:'ordinary',reversible:true})).toBe(0);
  expect(await send(page,'settle-home-inbox',{undo_of:key,items:[...items,{item_id:'ordinary'}],reversible:true})).toBe(0);
  expect(await send(page,'settle-home-inbox',{undo_of:key,reversible:true})).toBe(200);
});
test('waiting changes stay bound to the verified item', async ({page,context}) => {
  const item = await fixture(context,false,false,15);
  await card(page,15);
  expect(await send(page,'set-home-waiting',{item_id:'ordinary',items:[{item_id:item.item_id}]})).toBe(0);
  expect(await send(page,'set-home-waiting',{item_id:item.item_id})).toBe(200);
  expect(await send(page,'clear-home-waiting',{item_id:item.item_id})).toBe(200);
});`);
  const config = resolve(directory, 'playwright.config.ts');
  writeFileSync(config, `export default { testDir: '.', workers: 1, retries: 0, outputDir: './results', use: { baseURL: '${server.origin}', serviceWorkers: 'block' } };`);
  const { stdout } = await promisify(execFile)(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', config, '--reporter=json'], { timeout: 30_000 });
  const report = JSON.parse(stdout);
  assert.equal(report.stats.expected, 4);
  assert.equal(report.stats.skipped, 2);
  assert.equal(writes, 7);
  const skips = report.suites.flatMap(suite => suite.specs).filter(spec => spec.tests[0].results[0].status === 'skipped');
  for (const spec of skips) assert.match(JSON.stringify(spec.tests[0].annotations), /needs designated test record/);
});

test('notification prerequisite waits for successful readiness and fails on feed errors', async t => {
  const server = await startWorkerFixture({ routes:new Map([
    ['/updates',{body:'<div id="feedState" data-state="pending"></div><ul id="feedList"></ul>',contentType:'text/html'}],
    ['/doc-chats/test-answer',{body:'<div class="doc-message">Synthetic answer</div>',contentType:'text/html'}],
  ]) });
  t.after(() => server.close());
  const directory = temporaryDirectory('doctorcre-walk-notification-', t);
  writeFileSync(resolve(directory, 'notification.spec.ts'), `
import { test } from ${JSON.stringify(resolve('tests/walks/privacy.ts'))};
import ${JSON.stringify(resolve('tests/walks/11-WR-000620.spec.ts'))};
test.beforeEach(async ({ page }) => {
  await page.addInitScript(state => {
    if (location.pathname !== '/updates') return;
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => {
      document.querySelector('#feedList').innerHTML = state === 'ready' ? '<li>TEST answer <a href="/doc-chats/test-answer">Open answer</a></li>' : '';
      document.querySelector('#feedState').dataset.state = state;
    }, 200), { once: true });
  }, process.env.WALK_NOTIFICATION_STATE);
});`);
  const config = resolve(directory, 'playwright.config.ts');
  writeFileSync(config, `export default { testDir: '.', workers: 1, retries: 0, outputDir: './results', expect: { timeout: 1000 }, use: { baseURL: '${server.origin}', serviceWorkers: 'block' } };`);
  for (const scenario of ['ready', 'empty', 'unavailable', 'refused', 'pending']) {
    const result = await promisify(execFile)(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', config, '--reporter=json'], { timeout: 15_000, env: { ...process.env, WALK_NOTIFICATION_STATE: scenario } }).catch(error => error);
    const report = JSON.parse(result.stdout);
    if (scenario === 'ready') {
      assert.equal(server.requests.filter(row => row.path === '/doc-chats/test-answer').length, 2, 'The delayed notification must open and reload its stored answer');
      assert.equal(report.stats.skipped, 1);
      assert.match(JSON.stringify(report.suites), /same stored request ID/);
    } else if (scenario === 'empty') {
      assert.equal(report.stats.skipped, 1);
      assert.match(JSON.stringify(report.suites), /completed TEST Doc notification/);
    } else {
      assert.equal(report.stats.unexpected, 1, `${scenario} must fail instead of claiming the fixture is absent`);
      assert.equal(report.stats.skipped, 0);
    }
  }
});

test('every mutating walk skips without a TEST fixture and sends zero writes', async t => {
  const methods = [];
  const empty = { ok: true, schema_version: 'home-inbox.v5', truncated: false, limit: 1000, working_collapsed: true, auto_settle_enabled: true, items: [] };
  const server = await startWorkerFixture({routes:new Map([['/',{contentType:'text/html',body:'<h1>Welcome home.</h1><div class="inbox-health">Updating</div><script>fetch("/mcp", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({method:"tools/call",params:{name:"read-home-inbox-v5",arguments:{}}})}).then(r=>r.json()).then(()=>document.querySelector(".inbox-health").textContent="Up to date")</script>'}]]),env:{CARR:{fetch:async request => {
    const body = await request.text();
    methods.push({method:request.method,path:new URL(request.url).pathname,name:body ? JSON.parse(body)?.params?.name : null});
    return Response.json({result:{content:[{type:'text',text:JSON.stringify(empty)}]}});
  }}} });
  t.after(() => server.close());
  const directory = temporaryDirectory('doctorcre-walk-absent-', t);
  const specs = readdirSync('tests/walks').filter(name => /^(01|03|07|10|12|13|14|15|33)-/.test(name));
  for (const name of specs) writeFileSync(resolve(directory, name), `
import { expect } from ${JSON.stringify(require.resolve('@playwright/test'))};
import { test, inboxItems } from ${JSON.stringify(resolve('tests/walks/privacy.ts'))};
import { parseSnapshot } from ${JSON.stringify(resolve('src/ui/home/inbox.tsx'))};
import ${JSON.stringify(resolve('tests/walks', name))};
test.beforeEach(() => { expect(parseSnapshot(${JSON.stringify(empty)}).items).toEqual([]); });
test.afterEach(async ({context}) => { expect(await inboxItems(context)).toEqual([]); });`);
  const config = resolve(directory, 'playwright.config.ts');
  writeFileSync(config, `export default { testDir: '.', workers: 1, retries: 0, outputDir: './results', use: { baseURL: '${server.origin}', serviceWorkers: 'block' } };`);
  const { stdout } = await promisify(execFile)(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', config, '--reporter=json'], { timeout: 30_000 });
  const report = JSON.parse(stdout);
  assert.equal(report.stats.skipped, 9);
  assert.equal(report.stats.unexpected, 0);
  for (const suite of report.suites) for (const spec of suite.specs) assert.match(JSON.stringify(spec.tests[0].annotations), /needs designated test record: Home card named TEST WALK/);
  assert.ok(methods.length >= 9);
  assert.equal(methods.filter(request => request.method === 'POST').length, 9);
  assert.ok(methods.every(request => request.method === 'GET' || request.method === 'POST' && request.path === '/mcp' && request.name === 'read-home-inbox-v5'));
});

test('deal and tour discovery waits for asynchronously rendered records', async t => {
  const document = {contentType:'text/html',body:`<button id="listView">List</button><span id="boardStatusLabel">Ready</span><span id="boardAsOf">Updated</span><a class="deal-link" data-open-deal="synthetic" onclick="document.querySelector('#recordPanel').hidden=false;setTimeout(()=>document.querySelector('#recordPanel').innerHTML='<section class=deal-opening-snapshot>Deal snapshot</section><details class=deal-checklist></details>',200)">TEST deal</a><div id="recordPanel" hidden></div><button role="tab" onclick="setTimeout(()=>document.querySelector('#workspace-tours').innerHTML='<ul class=deal-tour-list><li data-open-tour>TEST tour</li></ul>',200)">Tours</button><div id="workspace-tours">Loading tours…</div>`};
  const server = await startWorkerFixture({routes:new Map([['/',document],['/deals',document]])});
  t.after(() => server.close());
  const directory = temporaryDirectory('doctorcre-walk-discovery-', t);
  writeFileSync(resolve(directory, 'discovery.spec.ts'), `
import { expect } from ${JSON.stringify(require.resolve('@playwright/test'))};
import { test } from ${JSON.stringify(resolve('tests/walks/privacy.ts'))};
import { deal, tab } from ${JSON.stringify(resolve('tests/walks/ui.ts'))};
test('delayed deal and tour records exist before prerequisite counts', async ({page}) => {
  await deal(page);
  expect(await page.locator('.deal-checklist').count()).toBe(1);
  await tab(page,/^Tours$/);
  expect(await page.locator('[data-open-tour]').count()).toBe(1);
});`);
  const config = resolve(directory, 'playwright.config.ts');
  writeFileSync(config, `export default { testDir: '.', workers: 1, retries: 0, outputDir: './results', use: { baseURL: '${server.origin}', serviceWorkers: 'block' } };`);
  const { stdout } = await promisify(execFile)(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', config, '--reporter=json'], { timeout: 15_000 });
  assert.equal(JSON.parse(stdout).stats.expected, 1);
});
