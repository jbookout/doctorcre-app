import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, waitForAsync } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { store, CONVERSATION, JOE_ASK, ANSWER } from './doc-request-fixture.mjs';
let path = JSON.parse(await readFile(new URL('../contracts/carr-interface.v1/doc_request_links.json', import.meta.url), 'utf8')).examples[0].deep_link;
if (process.env.CARR_CHECKOUT) {
  const {docConversationTools} = await import(pathToFileURL(resolve(process.env.CARR_CHECKOUT, 'mcp-server/src/doc-conversation.js')));
  const producer = store(docConversationTools);
  await producer.complete({request_msg_id: JOE_ASK, outcome: 'answered', answer_msg_id: ANSWER});
  path = producer.notifications[0].deep_link;
}
let server;
before(async () => { server = await fixtureServer(); });
after(() => server?.close());
async function open(t, { total = 60, answerAt = 59, failure = false, hold = false, inaccessible = false } = {}) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/{api/system-work/session,auth/session}', r => r.fulfill({json: {actor: {slug: 'joe'}, csrf_token: 'synthetic'}}));
  await page.route('**/js/fixture-client.js', async r => {
    let source = await readFile(new URL('../js/fixture-client.js', import.meta.url), 'utf8');
    source = source.replace('export async function createFixtureClient', 'async function originalFixture');
    source += `\nexport async function createFixtureClient(opts) {
      const c = await originalFixture(opts);
      const base = await c.readDocConversation({conversation_id:'0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01'});
      window.reads ||= [];
      c.readDocConversation = async args => {
        window.reads.push(args);
        if (${hold} && args.conversation_id === '${CONVERSATION}') await new Promise(resolve => window.releaseRead = resolve);
        if (${inaccessible}) throw {status:404, payload:{error:'doc_conversation_not_found'}};
        if (${failure}) throw new Error('synthetic read failure');
        const start = args.after_sequence || 0;
        return {...base, identity: {...base.identity, id: args.conversation_id},
          turns: Array.from({length: Math.min(args.limit, Math.max(0, (window.syntheticTotal ?? ${total})-start))}, (_, i) => ({
            sequence: start+i, msg_id: start+i === ${answerAt} ? '${ANSWER}' : '5b1c0a52-0000-4000-8000-'+String(start+i).padStart(12,'0'),
            role: start+i === ${answerAt} ? 'assistant' : 'human', body: 'Synthetic turn '+(start+i)+String.fromCharCode(39), at:'2026-11-01T00:00:00Z'
          })), more: start+args.limit < (window.syntheticTotal ?? ${total})};
      };
      return c;
    }`;
    await r.fulfill({contentType: 'text/javascript', body: source});
  });
  await page.addInitScript(() => { window.scrolls = 0; const scroll = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function(...args) { window.scrolls++; return scroll.apply(this, args); }; });
  await page.goto(server.origin+path, { waitUntil: 'domcontentloaded' });
  return page;
}
test('the exact answer beyond 50 turns receives focus and background refresh does not scroll', async t => {
  const page = await open(t);
  await page.waitForFunction(id => document.activeElement?.dataset.msgId === id, ANSWER);
  assert.equal(await page.locator('[data-target=true]').count(), 1);
  assert.equal(await page.locator('[data-target=true]').textContent().then(s => s.includes('Synthetic turn 59')), true);
  assert.deepEqual(await page.evaluate(() => window.reads.map(r => r.after_sequence ?? 0)), [0,50]);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const scrolls = await page.evaluate(() => window.scrolls);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => window.reads.length >= 4);
  assert.equal(await page.evaluate(() => window.scrolls), scrolls);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.msgId), ANSWER);
});
for (const [name, options] of [['missing target',{answerAt:-1}], ['empty conversation',{total:0}], ['read failure',{failure:true}], ['inaccessible conversation',{inaccessible:true}]]) {
  test(name+' never selects an invented answer', async t => {
    const page = await open(t, options);
    await waitForAsync(page, async () => !['pending'].includes((await import('/js/conversations.js')).view.conversation.state));
    assert.equal(await page.locator('[data-target=true]').count(), 0);
    assert.equal(await page.evaluate(() => window.scrolls), 0);
    if (!options.failure && !options.inaccessible) await page.getByText('The linked turn is unavailable in this conversation.').waitFor();
  });
}
test('page budget retains progress and Show more continues toward the answer', async t => {
  const page = await open(t, {total:5051, answerAt:5050});
  await page.getByText('The linked turn has not been reached. Show more to continue toward it.').waitFor();
  assert.equal(await page.evaluate(() => window.reads.length), 100);
  await page.locator('#showMore').click();
  await page.waitForFunction(id => document.activeElement?.dataset.msgId === id, ANSWER);
  assert.equal(await page.evaluate(() => window.reads.length), 102);
});
test('conversation navigation cancels a late target read and Back restores the target', async t => {
  const page = await open(t, {hold:true});
  await page.waitForFunction(() => Boolean(window.releaseRead));
  await page.locator('#conversationList [data-open]').first().click();
  await page.waitForURL('**/doc-chats?id=*');
  await page.evaluate(() => window.releaseRead());
  await waitForAsync(page, async () => (await import('/js/conversations.js')).view.conversation.state === 'read');
  assert.equal(await page.locator('[data-target=true]').count(), 0);
  await page.goBack();
  await page.waitForFunction(() => window.reads.at(-1)?.conversation_id === '5b1c0a52-0000-4000-8000-000000000001');
  await page.evaluate(() => { const timer = setInterval(() => { if (window.releaseRead) window.releaseRead(); if (document.querySelector('[data-target=true]')) clearInterval(timer); }, 10); });
  await page.waitForFunction(id => document.activeElement?.dataset.msgId === id, ANSWER);
});

for (const [name, total, answerAt, continuations, appended] of [
  ['target on page one', 40, 10, 0, 0],
  ['reviewer budget continuation', 5051, 5050, 1, 0],
  ['two budget continuations', 10051, 10050, 2, 0],
  ['new turns after the target', 5051, 5050, 1, 3],
]) {
  test('background refresh retains the answer and viewport after ' + name, async t => {
    const page = await open(t, {total, answerAt});
    for (let batch = 0; batch < continuations; batch++) {
      await page.getByText('The linked turn has not been reached. Show more to continue toward it.').waitFor();
      await page.locator('#showMore').click();
      await waitForAsync(page, async () => !(await import('/js/conversations.js')).view.conversation.refreshing);
    }
    await page.waitForFunction(id => document.activeElement?.dataset.msgId === id, ANSWER);
    const before = await page.evaluate(() => ({y: scrollY, scrolls: window.scrolls, reads: window.reads.length}));
    await page.evaluate(total => { window.syntheticTotal = total; window.dispatchEvent(new Event('online')); }, total + appended);
    await waitForAsync(page, async reads => {
      const {view} = await import('/js/conversations.js');
      return window.reads.length > reads && !view.conversation.refreshing;
    }, before.reads);
    assert.ok(await page.evaluate(reads => window.reads.length - reads <= 100, before.reads), 'each refresh batch must stay bounded');
    assert.equal(await page.locator('[data-target=true]').count(), 1, 'refresh must retain the reached target');
    assert.equal(await page.locator('[data-msg-id]').count(), total, 'refresh must retain the displayed extent');
    assert.equal(await page.evaluate(() => scrollY), before.y, 'refresh must preserve the viewport');
    assert.equal(await page.evaluate(() => window.scrolls), before.scrolls, 'refresh must not scroll to the answer again');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (continuations) {
      await page.getByText('Conversation refresh is incomplete. Show more to finish refreshing.').waitFor();
      for (let batch = 0; batch < continuations; batch++) {
        await page.locator('#showMore').click();
        await waitForAsync(page, async () => !(await import('/js/conversations.js')).view.conversation.refreshing);
      }
      assert.equal(await page.locator('[data-target=true]').count(), 1);
      assert.equal(await page.locator('[data-msg-id]').count(), total + appended);
      assert.equal(await page.evaluate(() => scrollY), before.y);
      assert.equal(await page.evaluate(() => window.scrolls), before.scrolls);
      assert.equal(await page.locator('#pagingBlock').isHidden(), true);
    }
  });
}
