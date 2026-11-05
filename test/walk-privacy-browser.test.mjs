import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

const require = createRequire(import.meta.url);

test('walk privacy covers consecutive spec files and secondary pages', async t => {
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') writes++;
    response.writeHead(request.method === 'POST' ? 200 : 429);
    response.end('synthetic');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
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
  writeFileSync(config, `export default { testDir: '.', workers: 1, retries: 0, outputDir: './results', use: { baseURL: 'http://127.0.0.1:${server.address().port}', serviceWorkers: 'block' } };`);
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
  const server = createServer((request, response) => {
    if (request.method !== 'GET') writes++;
    response.end('synthetic mutation sink');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = temporaryDirectory('doctorcre-walk-admission-', t);
  writeFileSync(resolve(directory, 'admission.spec.ts'), `
import { expect } from ${JSON.stringify(require.resolve('@playwright/test'))};
import { test } from ${JSON.stringify(resolve('tests/walks/privacy.ts'))};
import { card } from ${JSON.stringify(resolve('tests/walks/ui.ts'))};
import { fixtureInboxRpc } from ${JSON.stringify(resolve('src/ui/home/fixture.tsx'))};
import { parseSnapshot } from ${JSON.stringify(resolve('src/ui/home/inbox.tsx'))};
async function fixture(context, ordinary = false, missing = false) {
  const raw = await fixtureInboxRpc()('read-home-inbox-v5', {});
  const item = raw.items[0];
  item.title = 'TEST WALK 12 follow-up';
  const snapshot = parseSnapshot({ ...raw, items: missing ? [] : [item] });
  await context.route('**/*', async route => {
    const request = route.request();
    if (request.method() === 'POST' && request.postDataJSON()?.params?.name === 'read-home-inbox-v5') return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(snapshot) }] } } });
    if (request.method() !== 'GET') return route.fallback();
    if (new URL(request.url()).pathname === '/deals') return route.fulfill({ contentType: 'text/html', body: '<button id="listView">List</button><span id="boardStatusLabel">Ready</span><span id="boardAsOf">Updated</span><a class="deal-link" data-open-deal="' + item.deal_id + '">' + (ordinary ? 'Ordinary deal' : 'TEST WALK 12 deal') + '</a>' });
    return route.fulfill({ contentType: 'text/html', body: '<h1>Welcome home.</h1><div class="inbox-health">Updating</div><main></main><script>fetch("/mcp", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({params:{name:"read-home-inbox-v5"}})}).then(r=>r.json()).then(()=>{document.querySelector("main").innerHTML=' + JSON.stringify(missing ? '' : '<article data-inbox-row="' + item.item_id + '"><h3><a>' + item.title + '</a></h3><button>Mark done</button></article>') + ';document.querySelector(".inbox-health").textContent="Up to date"})</script>' });
  });
  return item;
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
});`);
  const config = resolve(directory, 'playwright.config.ts');
  writeFileSync(config, `export default { testDir: '.', workers: 1, retries: 0, outputDir: './results', use: { baseURL: 'http://127.0.0.1:${server.address().port}', serviceWorkers: 'block' } };`);
  const { stdout } = await promisify(execFile)(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', config, '--reporter=json'], { timeout: 30_000 });
  const report = JSON.parse(stdout);
  assert.equal(report.stats.expected, 1);
  assert.equal(report.stats.skipped, 2);
  assert.equal(writes, 2);
  const skips = report.suites.flatMap(suite => suite.specs).filter(spec => spec.tests[0].results[0].status === 'skipped');
  for (const spec of skips) assert.match(JSON.stringify(spec.tests[0].annotations), /needs designated test record/);
});

test('notification prerequisite waits for successful readiness and fails on feed errors', async t => {
  let state = 'ready';
  let answers = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url.startsWith('/doc-chats/')) {
      answers++;
      return response.end('<div class="doc-message">Synthetic answer</div>');
    }
    response.end(`<div id="feedState" data-state="pending"></div><ul id="feedList"></ul><script>setTimeout(()=>{document.querySelector('#feedList').innerHTML=${JSON.stringify(state === 'ready' ? '<li>TEST answer <a href="/doc-chats/test-answer">Open answer</a></li>' : '')};document.querySelector('#feedState').dataset.state=${JSON.stringify(state)}},200)</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = temporaryDirectory('doctorcre-walk-notification-', t);
  writeFileSync(resolve(directory, 'notification.spec.ts'), `import ${JSON.stringify(resolve('tests/walks/11-WR-000620.spec.ts'))};`);
  const config = resolve(directory, 'playwright.config.ts');
  writeFileSync(config, `export default { testDir: '.', workers: 1, retries: 0, outputDir: './results', expect: { timeout: 1000 }, use: { baseURL: 'http://127.0.0.1:${server.address().port}', serviceWorkers: 'block' } };`);
  for (const scenario of ['ready', 'empty', 'unavailable', 'refused', 'pending']) {
    state = scenario;
    const result = await promisify(execFile)(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', config, '--reporter=json'], { timeout: 15_000 }).catch(error => error);
    const report = JSON.parse(result.stdout);
    if (scenario === 'ready') {
      assert.equal(answers, 2, 'The delayed notification must open and reload its stored answer');
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
