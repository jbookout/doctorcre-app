import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { deepLinkView } from '../js/notifications-model.js';
import { handleDoctorcreRequest } from '../src/worker.js';
import { activeDestination } from '../js/navigation.js';
import * as routes from '../js/routes.js';
import { store, CONVERSATION, JOE_ASK, ANSWER } from './doc-request-fixture.mjs';
const carr = process.env.CARR_CHECKOUT;
const mirrored = new URL('../contracts/carr-interface.v1/doc_request_links.json', import.meta.url);
test('real completion mint opens the gated transcript and preserves both identities', { skip: !carr && 'Set CARR_CHECKOUT to the pinned producer checkout' }, async () => {
  const { docConversationTools } = await import(pathToFileURL(resolve(carr, 'mcp-server/src/doc-conversation.js')));
  const contract = JSON.parse(await readFile(mirrored, 'utf8'));
  for (const example of contract.examples) {
    const s = store(docConversationTools);
    await s.complete(example.input);
    const path = s.notifications[0].deep_link;
    assert.equal(path, example.deep_link);
    assert.equal(deepLinkView(path).href, path);
    assert.deepEqual(routes.docRequestTarget(path), { id: CONVERSATION, targetMsgId: example.input.answer_msg_id ? ANSWER : JOE_ASK });
    let gate, asset;
    const response = await handleDoctorcreRequest(new Request('https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev'+path), {
      APP_ENV: 'staging', CARR: {fetch: async req => {gate = new URL(req.url).pathname; return new Response(null);}},
      ASSETS: {fetch: async req => {asset = new URL(req.url).pathname; return new Response('transcript');}},
    });
    assert.equal(response.status, 200);
    assert.equal(gate, '/conversations');
    assert.equal(asset, '/conversations.html');
  }
  assert.equal(await readFile(mirrored, 'utf8'), await readFile(resolve(carr, 'mcp-server/contracts/doc-request-links.v1.json'), 'utf8'));
});

test('contract examples share one strict matcher and malformed paths stay unrouted', async () => {
  const contract = JSON.parse(await readFile(mirrored, 'utf8'));
  for (const example of contract.examples) {
    assert.equal(deepLinkView(example.deep_link).href, example.deep_link);
    assert.equal(activeDestination(example.deep_link), '/doc-chats');
    assert.equal(routes.routeKey(example.deep_link), '/doc/conversations/:conversation_id/turns/:msg_id');
  }
  for (const path of ['/doc/conversations/not-a-uuid/turns/'+ANSWER,
    `/doc/conversations/${CONVERSATION}/turns/nope`,
    `/doc/conversations/${CONVERSATION}/turns/${ANSWER}/extra`]) {
    assert.equal(routes.docRequestTarget(path), null);
    assert.equal(deepLinkView(path).routed, false);
  }
  assert.equal(deepLinkView('/doc-conversations/'+CONVERSATION).href, '/doc-chats?id='+CONVERSATION);
});

test('signed-out deep links retain the original turn in return_to', async () => {
  const path = `/doc/conversations/${CONVERSATION}/turns/${ANSWER}`;
  const response = await handleDoctorcreRequest(new Request('https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev'+path), {
    APP_ENV: 'staging', CARR: {fetch: async () => new Response(null, {status:302, headers: {location: "/auth/login?return_to=%2Fconversations"}})},
    ASSETS: {fetch: async () => {throw new Error('Unauthenticated asset access');}},
  });
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get('location')).searchParams.get('return_to'), path);
});
