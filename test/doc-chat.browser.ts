import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { expect, type Locator } from "@playwright/test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium, pausedClock } from "./browser-harness.mjs";
import { FixtureHtmlRewriter } from "./fixtures/worker-html.ts";

Object.defineProperty(globalThis, "HTMLRewriter", { configurable: true, value: FixtureHtmlRewriter });

const id = "00000000-0000-4000-8000-000000000001";
const question = "Which example deals are open?";
const created_at = "2026-01-01T00:00:00Z";
const conversation = { id, title: question, created_at };
const answeredTurn = {
  id: "00000000-0000-4000-8000-000000000002",
  position: 1,
  created_at,
  question,
  state: "answered",
  context: null,
  draft_review: null,
  waiting_reason: null,
  answer: { kind: "answer", text: "One example deal is open.", sources: [], proposal: null },
  confirmation: null,
};

async function docChatFixture(
  t: TestContext,
  respond: (request: Request) => Response | Promise<Response>,
  actor = () => "joe",
  pageOptions: { viewport?: { width: number; height: number }; hasTouch?: boolean } = {},
) {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: {
      PARTNER_SIGN_IN: "engine",
      PARTNER_APP: {
        async fetch(request: Request) {
          const slug = actor();
          if (new URL(request.url).pathname === "/auth/session") {
            return Response.json({ actor: { slug }, csrf_token: `${slug}-test` });
          }
          return respond(request);
        },
      },
    },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>> | undefined;
  t.after(async () => {
    try {
      await page?.unrouteAll({ behavior: "ignoreErrors" });
      await browser?.close();
    } finally {
      await server.close();
    }
  });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, ...pageOptions });
  return { page, origin: server.origin };
}

async function filingReviewFixture(t: TestContext) {
  const proposalId = "00000000-0000-4000-8000-000000000011";
  const activityId = "00000000-0000-4000-8000-000000000012";
  const displayId = "00000000-0000-4000-8000-000000000013";
  const reviewKey = `suggestion:${proposalId}`;
  const reviewPath = `/inbox/card/${encodeURIComponent(reviewKey)}`;
  const advice = "The east suite deal looks like the best match.";
  const context = { kind: "email", id: activityId };
  const asks: unknown[] = [];
  const writes: unknown[] = [];
  const { page, origin } = await docChatFixture(t, async (request) => {
    switch (new URL(request.url).pathname) {
      case "/api/engine/doc/conversations":
        return Response.json({ conversations: [], next_before: null });
      case "/api/engine/doc/turns": {
        const ask = await request.json();
        asks.push(ask.context);
        return Response.json({
          conversation_id: id,
          turn: {
            ...answeredTurn,
            question: ask.question,
            idempotency_key: ask.idempotency_key,
            context,
            answer: { kind: "answer", text: advice, sources: [], proposal: null },
          },
        });
      }
      default:
        if (request.method !== "GET") writes.push(request.url);
        return new Response(null, { status: 404 });
    }
  });
  const app = "https://app.doctorcre.com";
  await page.route(`${app}/**`, async (route) => {
    await route.fulfill({ response: await route.fetch({ url: route.request().url().replace(app, origin) }) });
  });
  await page.route("**/mcp", async (route) => {
    const {
      id: rpcId,
      params: { name, arguments: args },
    } = route.request().postDataJSON();
    let payload = {};
    if (name === "read-engine-home-card") {
      assert.equal(args.item_id, reviewKey);
      payload = {
        item_id: reviewKey,
        source_type: "email_proposal",
        source_id: proposalId,
        source_version: "1",
        source_state: "needs_attention",
        title: "Review where to file this email",
        base_version: "1:0:inbox",
        activity_at: created_at,
        section: "inbox",
        disposition: "inbox",
        unseen: false,
        snoozed_until: null,
        hold_until: null,
        kind_label: "Suggestion",
        waiting_version: 0,
        waiting_on: null,
        merged_source_ids: [],
        suggestions: [{ id: proposalId, activity_id: activityId, activity_kind: "email" }],
        context_label: null,
        due_on: null,
        open_url: null,
        deal_id: null,
        action_id: null,
        action_version: null,
        completed_at: null,
      };
    } else if (name === "read-engine-home-proposal") {
      assert.equal(args.id, proposalId);
      payload = {
        proposal_id: proposalId,
        kind: "possible_new_deal",
        evidence: "Synthetic filing evidence",
        filing_choices: [
          { kind: "deal", label: "Choose deal" },
          { kind: "vendor", label: "Choose vendor" },
        ],
        source_activity: { kind: "email", id: displayId, subject: "Suite plans" },
        thread: [
          { activity_id: id, happened_at: created_at, body: "The first message." },
          { activity_id: displayId, happened_at: "2026-01-02T00:00:00Z", body: "The message under review." },
          { activity_id: proposalId, happened_at: "2026-01-03T00:00:00Z", body: "The newest message." },
        ],
      };
    } else if (name.startsWith("decide-") || name.startsWith("set-")) writes.push(name);
    await route.fulfill({
      json: { jsonrpc: "2.0", id: rpcId, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
    });
  });
  const openReview = () => page.goto(app + reviewPath);
  await openReview();
  const filing = page.getByRole("region", { name: "File this email", exact: true });
  const askDoc = filing.getByRole("link", { name: "Ask Doc", exact: true });
  return { page, openReview, filing, askDoc, asks, writes, context, advice };
}

test("Ask Doc advises on the filing's originating email without deciding the review", async (t) => {
  const { page, openReview, filing, askDoc, asks, writes, context, advice } = await filingReviewFixture(t);
  await expect(page.getByRole("region", { name: "Email thread" }).locator("article")).toHaveCount(3);
  await expect(askDoc).toHaveCount(1);
  await askDoc.click();
  await expect(page.getByLabel("Question for Doc")).toHaveValue("Where should I file this email?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(advice)).toBeVisible();
  assert.deepEqual(asks, [context]);
  assert.deepEqual(writes, []);
  await openReview();
  await expect(filing.getByRole("button", { name: "Choose deal" })).toBeVisible();
  await expect(filing.getByRole("button", { name: "Drop", exact: true })).toBeVisible();
  await expect(filing.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
});

test("Reopening Ask Doc from a filing review keeps the unsent question", async (t) => {
  const { page, openReview, askDoc, asks } = await filingReviewFixture(t);
  const composer = page.getByLabel("Question for Doc");
  const unsent = "Could this belong to the example vendor instead?";
  await askDoc.click();
  await expect(composer).toHaveValue("Where should I file this email?");
  await composer.fill(unsent);
  await openReview();
  await askDoc.click();
  await expect(composer).toHaveValue(unsent);
  assert.deepEqual(asks, []);
});

for (const path of ["list", "detail"] as const) {
  test(`A malformed 200 from the Doc chat ${path} offers a load retry`, async (t) => {
    let malformed = true;
    const { page, origin } = await docChatFixture(t, (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [conversation], next_before: malformed && path === "list" ? 1 : null });
        case `/api/engine/doc/conversations/${id}`:
          return Response.json({ conversation: malformed ? null : conversation, turns: [] });
        default:
          return Response.json({}, { status: 404 });
      }
    });
    await page.goto(`${origin}/doc-chats?mode=live${path === "detail" ? `&chat=${id}` : ""}`);
    await expect(page.getByRole("status")).toHaveText("Chats couldn’t be loaded.");
    malformed = false;
    await page.getByRole("button", { name: "Retry loading" }).click();
    await expect(page.getByLabel("Question for Doc")).toBeEnabled();
    await page.getByRole("button", { name: "Recent chats", exact: true }).click();
    await expect(page.getByRole("link", { name: question })).toBeVisible();
  });
}

for (const scenario of ["send", "retry", "send with an empty conversation ID"] as const) {
  test(`A malformed 200 from Doc ${scenario} keeps the question and offers a send retry`, async (t) => {
    const asks: unknown[] = [];
    const malformedAttempt = scenario === "retry" ? 2 : 1;
    const emptyId = scenario === "send with an empty conversation ID";
    const { page, origin } = await docChatFixture(t, async (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: emptyId ? [conversation] : [], next_before: null });
        case `/api/engine/doc/conversations/${id}`:
          return Response.json({ conversation, turns: [] });
        case "/api/engine/doc/turns": {
          const ask: unknown = await request.json();
          asks.push(ask);
          assert.ok(ask && typeof ask === "object" && "idempotency_key" in ask);
          if (asks.length < malformedAttempt) return Response.json({}, { status: 503 });
          const malformed = asks.length === malformedAttempt;
          return Response.json({
            conversation_id: malformed && emptyId ? "" : id,
            turn: {
              ...answeredTurn,
              position: malformed && !emptyId ? 0 : 1,
              idempotency_key: ask.idempotency_key,
            },
          });
        }
        default:
          return Response.json({}, { status: 404 });
      }
    });
    const chatUrl = `${origin}/doc-chats?mode=live${emptyId ? `&chat=${id}` : ""}`;
    await page.goto(chatUrl);
    const composer = page.getByLabel("Question for Doc");
    const status = page.getByRole("status");
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await composer.fill(question);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    if (scenario === "retry") {
      await expect(status).toHaveText("The question couldn’t be sent. Try again.");
      await retry.click();
    }
    await expect(status).toHaveText("The question couldn’t be sent. Try again.");
    await expect(composer).toHaveValue(question);
    await expect(page).toHaveURL(chatUrl);
    await retry.click();
    await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
    assert.equal(asks.length, malformedAttempt + 1);
    for (const ask of asks) assert.deepEqual(ask, asks[0]);
  });
}

test("Ask Doc opens saved turns, retries the first ask with its original payload, and clears on account change", async (t) => {
  const payloads: unknown[] = [];
  let actor = "joe";
  let state = "queued";
  let firstKey = "";
  let malformed = false;
  const first = () => ({
    ...answeredTurn,
    idempotency_key: firstKey,
    state,
    waiting_reason: state === "queued" ? "Doc isn't set up on your Mac yet." : null,
    answer: state === "answered" ? answeredTurn.answer : null,
  });
  const { page, origin } = await docChatFixture(
    t,
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/engine/doc/conversations")
        return Response.json({ conversations: firstKey && actor === "joe" ? [conversation] : [], next_before: null });
      if (path === `/api/engine/doc/conversations/${id}`)
        return actor === "joe"
          ? Response.json(malformed ? { conversation } : { conversation, turns: [first()] })
          : Response.json({}, { status: 404 });
      if (path !== "/api/engine/doc/turns") return Response.json({}, { status: 404 });
      assert.equal(request.headers.get("x-carr-csrf"), "joe-test");
      const ask: unknown = await request.json();
      payloads.push(ask);
      assert.ok(ask && typeof ask === "object" && "idempotency_key" in ask && typeof ask.idempotency_key === "string");
      if (!firstKey) firstKey = ask.idempotency_key;
      if (payloads.length < 3) return Response.json({ conversation_id: id, turn: first() }, { status: 202 });
      return Response.json(
        {
          conversation_id: id,
          turn: {
            ...answeredTurn,
            id: "00000000-0000-4000-8000-000000000003",
            position: 2,
            question: "Any follow-ups?",
            state: "working",
            idempotency_key: ask.idempotency_key,
            context: null,
            answer: null,
            waiting_reason: null,
          },
        },
        { status: 202 },
      );
    },
    () => actor,
  );
  await page.clock.install();
  const evalViolations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.blockedURI === "eval") console.error("Doc chat attempted to evaluate JavaScript");
    });
  });
  page.on("console", (message) => {
    if (message.text() === "Doc chat attempted to evaluate JavaScript") evalViolations.push(message.text());
  });
  const navigation = await page.goto(`${origin}/doc-chats?mode=live`);
  assert.match(navigation?.headers()["content-security-policy"] ?? "", /script-src 'self'/);
  const composer = page.getByLabel("Question for Doc");
  await expect(composer).toBeEnabled();
  await composer.fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Doc isn't set up on your Mac yet.")).toBeVisible();
  assert.match(page.url(), /[?&]chat=/);
  await page.reload();
  await expect(page.getByText("Doc isn't set up on your Mac yet.")).toBeVisible();
  malformed = true;
  await page.reload();
  await expect(page.getByText("Chats couldn’t be loaded.")).toBeVisible();
  malformed = false;
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByText("Doc isn't set up on your Mac yet.")).toBeVisible();
  await page.getByRole("link", { name: "New chat" }).click();
  state = "failed";
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await page.getByRole("link", { name: question }).click();
  await expect(page.getByText("Doc couldn’t answer.")).toBeVisible();
  state = "queued";
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Doc isn't set up on your Mac yet.")).toBeVisible();
  assert.deepEqual(payloads[1], payloads[0]);
  state = "answered";
  await page.clock.fastForward(5_000);
  await expect(page.getByText("One example deal is open.")).toBeVisible();
  await composer.fill("Any follow-ups?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/^Doc is working · /)).toBeVisible();
  assert.deepEqual(payloads[2], {
    question: "Any follow-ups?",
    idempotency_key: Reflect.get(Object(payloads[2]), "idempotency_key"),
    conversation_id: id,
  });
  await composer.fill("An unsent follow-up");
  actor = "dell";
  await page.clock.fastForward(5_000);
  await expect(page).toHaveURL(`${origin}/public-shell/session-ended.html`);
  await expect(page.getByText(question, { exact: true })).toHaveCount(0);
  await expect(page.getByText("One example deal is open.")).toHaveCount(0);
  await expect(composer).toHaveCount(0);
  const foreign = await page.request.get(`${origin}/api/engine/doc/conversations/${id}`);
  assert.equal(foreign.status(), 404);
  assert.deepEqual(evalViolations, []);
});

for (const storageBlocked of [false, true]) {
  test(`Ask Doc question drafts ${storageBlocked ? "are optional when storage is blocked" : "survive reload until sent or the session ends"}`, async (t) => {
    let actor = "joe";
    const errors: Error[] = [];
    const { page, origin } = await docChatFixture(
      t,
      async (request) => {
        switch (new URL(request.url).pathname) {
          case "/api/engine/doc/conversations":
            return Response.json({ conversations: [conversation], next_before: null });
          case detailPath:
            return Response.json({ conversation, turns: [] });
          case "/api/engine/doc/turns": {
            const { idempotency_key } = await request.json();
            return Response.json({ conversation_id: id, turn: { ...answeredTurn, idempotency_key } });
          }
          default:
            return new Response(null, { status: 404 });
        }
      },
      () => actor,
    );
    if (storageBlocked) {
      await page.addInitScript(() => {
        for (const name of ["localStorage", "sessionStorage"]) {
          Object.defineProperty(window, name, {
            get() {
              throw new DOMException("Storage blocked", "SecurityError");
            },
          });
        }
      });
    }
    page.on("pageerror", (error) => errors.push(error));
    const start = `${origin}/doc-chats?mode=live`;
    const chat = `${start}&chat=${id}`;
    const composer = page.getByLabel("Question for Doc");
    await page.goto(chat);
    await composer.fill(question);
    await page.reload();
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue(storageBlocked ? "" : question);
    if (storageBlocked) {
      await composer.fill(question);
    } else {
      await page.goto(start);
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue("");
      await page.getByRole("button", { name: "Recent chats", exact: true }).click();
      await page.getByRole("link", { name: question }).click();
      await expect(composer).toHaveValue(question);
    }
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
    await page.reload();
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue("");

    if (!storageBlocked) {
      await composer.fill("Draft before account change");
      await page.goto(start);
      await composer.fill("Unsent first question");
      await page.reload();
      await expect(composer).toHaveValue("Unsent first question");
      actor = "dell";
      await page.reload();
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue("");
      await page.goto(chat);
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue("");
      await composer.fill("Draft before sign-out");
    }
    await page.evaluate(async () => {
      const { privateSession } = await import(String("/js/private-session.js"));
      privateSession().revoke("signed-out");
    });
    await expect(page).toHaveURL(`${origin}/public-shell/session-ended.html`);
    await page.goto(chat);
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue("");
    if (!storageBlocked) {
      actor = "joe";
      await page.goto(chat);
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue("");
      await page.goto(start);
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue("");
    }
    assert.deepEqual(errors, []);
  });
}

const otherId = "00000000-0000-4000-8000-000000000021";
const otherConversation = { id: otherId, title: "Who is the example contact?", created_at };
const firstDraft = "Which example deals are still open this month?";
const otherDraft = "Who is the example contact at the north campus?";

async function questionDraftFixture(
  t: TestContext,
  conversations: { id: string; title: string; created_at: string }[] = [conversation],
) {
  return docChatFixture(t, async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations") return Response.json({ conversations, next_before: null });
    const detail = conversations.find((row) => path === `/api/engine/doc/conversations/${row.id}`);
    if (detail) return Response.json({ conversation: detail, turns: [] });
    if (path === "/api/engine/doc/turns") {
      const { question: asked, idempotency_key, conversation_id } = await request.json();
      const chat = conversations.find((row) => row.id === conversation_id) ?? conversation;
      return Response.json({
        conversation_id: chat.id,
        turn: { ...answeredTurn, id: chat.id, question: asked, idempotency_key },
      });
    }
    return new Response(null, { status: 404 });
  });
}

test("A half-typed Doc question comes back after a reload, with the cursor at the end", async (t) => {
  const { page, origin } = await questionDraftFixture(t);
  const composer = page.getByLabel("Question for Doc");
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await composer.fill(firstDraft);
  await page.reload();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue(firstDraft);
  await expect(composer).toBeFocused();
  assert.equal(await composer.evaluate((box: HTMLTextAreaElement) => box.selectionStart), firstDraft.length);
  assert.equal(await composer.evaluate((box: HTMLTextAreaElement) => box.selectionEnd), firstDraft.length);
});

test("A half-typed Doc question is still there after the tab is closed", async (t) => {
  const { page, origin } = await questionDraftFixture(t);
  const chat = `${origin}/doc-chats?mode=live&chat=${id}`;
  await page.goto(chat);
  await page.getByLabel("Question for Doc").fill(firstDraft);
  const next = await page.context().newPage();
  t.after(() => next.close());
  await next.goto(chat);
  const composer = next.getByLabel("Question for Doc");
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue(firstDraft);
});

test("Sending a Doc question clears the saved draft", async (t) => {
  const { page, origin } = await questionDraftFixture(t);
  const chat = `${origin}/doc-chats?mode=live&chat=${id}`;
  const composer = page.getByLabel("Question for Doc");
  await page.goto(chat);
  await composer.fill(firstDraft);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
  await expect(composer).toHaveValue("");
  const next = await page.context().newPage();
  t.after(() => next.close());
  await next.goto(chat);
  const restored = next.getByLabel("Question for Doc");
  await expect(restored).toBeEnabled();
  await expect(restored).toHaveValue("");
});

test("Two Doc conversations keep separate drafts", async (t) => {
  const { page, origin } = await questionDraftFixture(t, [conversation, otherConversation]);
  const firstChat = `${origin}/doc-chats?mode=live&chat=${id}`;
  const otherChat = `${origin}/doc-chats?mode=live&chat=${otherId}`;
  const composer = page.getByLabel("Question for Doc");
  await page.goto(firstChat);
  await composer.fill(firstDraft);
  await page.goto(otherChat);
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue("");
  await composer.fill(otherDraft);
  const next = await page.context().newPage();
  t.after(() => next.close());
  await next.goto(firstChat);
  const restored = next.getByLabel("Question for Doc");
  await expect(restored).toBeEnabled();
  await expect(restored).toHaveValue(firstDraft);
  await next.goto(otherChat);
  await expect(restored).toBeEnabled();
  await expect(restored).toHaveValue(otherDraft);
});

test("New chat keeps a draft already typed on a new chat and drops it when leaving a conversation", async (t) => {
  const { page, origin } = await questionDraftFixture(t);
  const composer = page.getByLabel("Question for Doc");
  const newChat = page.getByRole("link", { name: "New chat" }).first();
  await page.goto(`${origin}/doc-chats?mode=live`);
  await expect(composer).toBeEnabled();
  await composer.fill(firstDraft);
  await newChat.click();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue(firstDraft);
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(composer).toBeEnabled();
  await newChat.click();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue("");
});

test("Emptying the Doc question box clears its saved draft", async (t) => {
  const { page, origin } = await questionDraftFixture(t);
  const chat = `${origin}/doc-chats?mode=live&chat=${id}`;
  const composer = page.getByLabel("Question for Doc");
  await page.goto(chat);
  await composer.fill(firstDraft);
  await composer.fill("");
  await page.reload();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue("");
});

test("Blocked device storage still lets the partner type and send a Doc question", async (t) => {
  const { page, origin } = await questionDraftFixture(t);
  await page.addInitScript(() => {
    const fail = () => {
      throw new DOMException("Storage blocked", "SecurityError");
    };
    for (const target of [window.localStorage, window.sessionStorage]) {
      target.setItem = fail;
      target.getItem = fail;
      target.removeItem = fail;
    }
  });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  const composer = page.getByLabel("Question for Doc");
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(composer).toBeEnabled();
  await composer.fill(firstDraft);
  await expect(composer).toHaveValue(firstDraft);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
  assert.deepEqual(errors, []);
});

test("Doc accepts engine IDs without RFC version or variant bits", async (t) => {
  const engineId = "11111111-2222-3333-4444-555555555555";
  const engineConversation = { ...conversation, id: engineId };
  const { page, origin } = await docChatFixture(t, async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [engineConversation], next_before: engineId });
    if (path === `/api/engine/doc/conversations/${engineId}`)
      return Response.json({ conversation: engineConversation, turns: [] });
    if (path === "/api/engine/doc/turns") {
      const ask = await request.json();
      assert.equal(ask.conversation_id, engineId);
      return Response.json({
        conversation_id: engineId,
        turn: { ...answeredTurn, id: engineId, idempotency_key: engineId },
      });
    }
    return Response.json({}, { status: 404 });
  });
  await page.goto(`${origin}/doc-chats?mode=live`);
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await page.getByRole("link", { name: question }).click();
  await page.getByLabel("Question for Doc").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
});

test("Backup answers are marked while Mac answers and waiting questions are not", async (t) => {
  let source: string | null = "backup";
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [conversation], next_before: null });
    if (path === `/api/engine/doc/conversations/${id}`)
      return Response.json({
        conversation,
        turns: [
          {
            ...answeredTurn,
            idempotency_key: id,
            answered_by: source,
            state: source ? "answered" : "queued",
            answer: source ? answeredTurn.answer : null,
            waiting_reason: source ? null : "Doc answers when your Mac is on.",
          },
        ],
      });
    return Response.json({}, { status: 404 });
  });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText("Answered by backup")).toBeVisible();
  source = "mac";
  await page.reload();
  await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
  await expect(page.getByText("Answered by backup")).toHaveCount(0);
  source = "future-source";
  await page.reload();
  await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
  await expect(page.getByText("Answered by backup")).toHaveCount(0);
  source = null;
  await page.reload();
  await expect(page.getByText("Doc answers when your Mac is on.")).toBeVisible();
  await expect(page.getByText("Answered by backup")).toHaveCount(0);
});

test("A reopened Doc question keeps its place and lets the partner draft a follow-up as it refreshes", async (t) => {
  const waitingLines = [
    "Doc answers when your Mac is on.",
    "Doc is paused until your model's plan resets.",
    "On the Mac that runs Doc, sign in again to the AI app Doc was set up with.",
    "Doc is waiting for a free slot on your Mac.",
    "Doc is waiting for a new reason.",
  ] as const;
  const saved = { ...answeredTurn, idempotency_key: id };
  let state = "queued";
  let waitingReason: string | null = waitingLines[0];
  const detailPath = `/api/engine/doc/conversations/${id}`;
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [conversation], next_before: null });
    if (path === detailPath)
      return Response.json({
        conversation,
        turns: [{ ...saved, state, waiting_reason: waitingReason, answer: state === "answered" ? saved.answer : null }],
      });
    return Response.json({}, { status: 404 });
  });
  const docReads: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/engine/doc/")) docReads.push(path);
  });
  await pausedClock(page, new Date(created_at));
  const url = `${origin}/doc-chats?mode=live&chat=${id}`;
  await page.goto(url);
  await expect(page.getByText(waitingLines[0], { exact: true })).toBeVisible();
  const composer = page.getByLabel("Question for Doc");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await composer.fill("Any follow-ups?");
  await expect(send).toBeDisabled();

  for (const waiting_reason of waitingLines.slice(1)) {
    waitingReason =
      waiting_reason === "On the Mac that runs Doc, sign in again to the AI app Doc was set up with."
        ? "Sign in to Claude Code on your Mac."
        : waiting_reason === "Doc is paused until your model's plan resets."
          ? "Doc is paused until your Claude plan resets."
          : waiting_reason;
    await page.clock.runFor(5_000);
    await expect(page.getByText(waiting_reason, { exact: true })).toBeVisible();
  }
  state = "working";
  waitingReason = null;
  await page.clock.runFor(5_000);
  await expect(page.getByText(/^Doc is working · /)).toBeVisible();

  state = "answered";
  await page.clock.runFor(5_000);
  await expect(page.getByText(saved.answer.text)).toBeVisible();
  await expect(page.getByText(question, { exact: true }).and(page.locator("p"))).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Check for answer|Refresh chat/ })).toHaveCount(0);
  await expect(page).toHaveURL(url);
  await expect(composer).toHaveValue("Any follow-ups?");
  await expect(composer).toBeFocused();
  await expect(send).toBeEnabled();

  await page.clock.runFor(15_000);
  const linkPath = "/api/engine/doc/link";
  assert.deepEqual(
    docReads.filter((path) => path !== linkPath),
    ["/api/engine/doc/conversations", ...Array(waitingLines.length + 2).fill(detailPath)],
  );
  assert.equal(
    docReads.filter((path) => path === linkPath).length,
    waitingLines.length + 2,
    "the Mac status is read once on load and again each time the question's state changes",
  );
});

const detailPath = `/api/engine/doc/conversations/${id}`;
const queuedTurn = { ...answeredTurn, idempotency_key: id, state: "queued", answer: null };
const answered = { ...answeredTurn, idempotency_key: id };

function waitingChat(t: TestContext) {
  return docChatFixture(t, (request) => {
    switch (new URL(request.url).pathname) {
      case "/api/engine/doc/conversations":
        return Response.json({ conversations: [conversation], next_before: null });
      case detailPath:
        return Response.json({ conversation, turns: [queuedTurn] });
      default:
        return Response.json({}, { status: 404 });
    }
  });
}

test("Back reloads Ask Doc once and a failed session check cannot read the saved chat", async (t) => {
  const { page, origin } = await waitingChat(t);
  await pausedClock(page, new Date(created_at));
  const url = `${origin}/doc-chats?mode=live&chat=${id}`;
  await page.goto(url);
  await expect(page.getByText(/^Doc is working · /)).toBeVisible();
  const composer = page.getByLabel("Question for Doc");
  await composer.fill("An unsent Back follow-up");

  let reloads = 0;
  let detailReads = 0;
  await page.route(url, (route) => {
    reloads++;
    return route.continue();
  });
  await page.route(`**${detailPath}`, (route) => {
    detailReads++;
    return route.fulfill({ json: { conversation, turns: [answered] } });
  });
  const sessionUrl = "**/auth/session";
  await page.route(sessionUrl, (route) => route.fulfill({ status: 503 }));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow")));
  assert.equal(reloads, 0);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByRole("button", { name: "Retry loading" })).toBeVisible({ timeout: 5_000 });
  await page.clock.runFor(5_000);
  assert.equal(reloads, 1);
  assert.equal(detailReads, 0);
  await expect(page.getByText(/^Doc is working · /)).toHaveCount(0);

  await page.unroute(sessionUrl);
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByText(answered.answer.text)).toBeVisible();
  await expect(composer).toHaveValue("An unsent Back follow-up");
  assert.equal(detailReads, 1);
  assert.equal(reloads, 1);
});

test("A visible Ask Doc chat can receive its answer after three idle hours", async (t) => {
  const { page, origin } = await waitingChat(t);
  await pausedClock(page, new Date(created_at));
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText(/^Doc is working · /)).toBeVisible();

  const reads = await page.evaluateHandle(
    ({ detailPath, conversation, queuedTurn, answered }) => {
      const requests: { path: string; minute: number }[] = [];
      const started = Date.now();
      window.fetch = async (input) => {
        const path = String(input);
        const minute = (Date.now() - started) / 60_000;
        requests.push({ path, minute });
        if (path === "/auth/session") return Response.json({ actor: { slug: "joe" }, csrf_token: "joe-test" });
        if (path !== detailPath) return Response.json({}, { status: 404 });
        const waiting_reason =
          minute >= 120
            ? "Doc is paused until your Claude plan resets."
            : minute >= 60
              ? "Doc answers when your Mac is on."
              : null;
        return Response.json({
          conversation,
          turns: [minute >= 180 ? answered : { ...queuedTurn, waiting_reason }],
        });
      };
      return requests;
    },
    { detailPath, conversation, queuedTurn, answered },
  );
  await page.clock.runFor(182 * 60_000);
  await expect(page.getByText(answered.answer.text)).toBeVisible();
  const requests = (await reads.jsonValue()).filter(({ path }) => path.startsWith("/api/engine/doc/"));
  await reads.dispose();
  const linkPath = "/api/engine/doc/link";
  assert.deepEqual([...new Set(requests.map(({ path }) => path).filter((path) => path !== linkPath))], [detailPath]);
  assert.ok(
    requests.filter(({ path }) => path === linkPath).length <= 3,
    "the Mac status is read only when the question changes",
  );
  for (const [start, end, expected] of [
    [0, 1, 12],
    [1, 60, 118],
    [60, 120, 30],
    [120, 180, 30],
  ] as const) {
    const count = requests.filter(({ minute }) => minute > start && minute <= end).length;
    assert.ok(
      Math.abs(count - expected) <= 2,
      `Expected about ${expected} reads from minute ${start} to ${end}, got ${count}`,
    );
  }
});

test("An unavailable chat keeps the unsent question and other recent chats for the same account", async (t) => {
  const other = { ...conversation, id: answeredTurn.id, title: "Another example chat" };
  let unavailable = false;
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [conversation, other], next_before: null });
    if (path === detailPath && !unavailable) return Response.json({ conversation, turns: [queuedTurn] });
    return Response.json({}, { status: 404 });
  });
  await pausedClock(page, new Date(created_at));
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText(/^Doc is working · /)).toBeVisible();
  const composer = page.getByLabel("Question for Doc");
  const otherChat = page.getByRole("link", { name: other.title });
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await expect(otherChat).toBeVisible();
  await composer.fill("An unsent follow-up");

  unavailable = true;
  await page.clock.runFor(5_000);
  await expect(page.getByRole("status")).toHaveText("Conversation unavailable");
  await expect(composer).toHaveValue("An unsent follow-up");
  await expect(composer).toBeEnabled();
  await expect(otherChat).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
});

test("Ask Doc retries an exhausted read after a quick tab return with input", async (t) => {
  const { page, origin } = await waitingChat(t);
  await pausedClock(page, new Date(created_at));
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText(/^Doc is working · /)).toBeVisible();

  await page.clock.runFor(500);
  await page.evaluate(() => {
    for (const value of ["hidden", "visible"]) {
      Object.defineProperty(document, "visibilityState", { configurable: true, value });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  await page.clock.runFor(4_999);

  const reads = await page.evaluateHandle(
    async ({ detailPath, conversation, answered }) => {
      const { privateSession } = await import(String("/js/private-session.js"));
      const session = privateSession();
      const paths: string[] = [];
      window.fetch = async (input) => {
        const path = String(input);
        if (path === "/fixture/other-read") return Response.json({});
        paths.push(path);
        if (path === "/auth/session") return Response.json({ actor: { slug: "joe" }, csrf_token: "joe-test" });
        if (path === detailPath) return Response.json({ conversation, turns: [answered] });
        return Response.json({}, { status: 404 });
      };
      await Promise.allSettled(Array.from({ length: 600 }, () => session.fetch("/fixture/other-read")));
      return paths;
    },
    { detailPath, conversation, answered },
  );
  const paused = page.getByRole("status", { includeHidden: true }).filter({ hasText: /paused/i });
  await page.clock.runFor(1);
  assert.deepEqual(await reads.jsonValue(), [], "the first chat read is refused");
  await expect(paused).toHaveCount(1);
  await page.keyboard.press("Shift");
  const noticesAfterInput = await paused.count();
  await page.clock.runFor(5_000);
  assert.deepEqual(
    (await reads.jsonValue()).filter((path) => path !== "/api/engine/doc/link"),
    [detailPath],
    "the next tick reads without another visibility event",
  );
  assert.equal(noticesAfterInput, 1, "input does not clear the pause");
  await expect(page.getByText(answered.answer.text)).toBeVisible();
  await expect(paused).toHaveCount(0);
  await reads.dispose();
});

test("Doc links to app records and renders other source labels as text", async (t) => {
  const ref = { kind: "deal", id };
  const href = `/deals?deal=${id}`;
  const unsafe = [
    { ref, label: "Script source", href: "javascript:void(0)" },
    { ref, label: "External source", href: "https://example.test/deal" },
    { ref, label: "Network-path source", href: "//example.test/deal" },
    { ref, label: "Backslash source", href: "/\\example.test/deal" },
    { ref, label: "Data source", href: "data:text/plain,example" },
  ];
  const turn = {
    ...answeredTurn,
    idempotency_key: id,
    answer: {
      ...answeredTurn.answer,
      sources: [{ ref, label: "Example deal record", href }, ...unsafe],
    },
  };
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [conversation], next_before: null });
    if (path === `/api/engine/doc/conversations/${id}`) return Response.json({ conversation, turns: [turn] });
    return Response.json({}, { status: 404 });
  });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByRole("link", { name: "Example deal record" })).toHaveAttribute("href", href);
  for (const { label } of unsafe) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: label })).toHaveCount(0);
  }
});

test("Session invalidation aborts an in-flight Doc refresh and clears the chat", async (t) => {
  const waiting = "Doc answers when your Mac is on.";
  const turn = { ...answeredTurn, idempotency_key: id, state: "queued", answer: null, waiting_reason: waiting };
  const detailPath = `/api/engine/doc/conversations/${id}`;
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/conversations")
      return Response.json({ conversations: [conversation], next_before: null });
    if (path === detailPath) return Response.json({ conversation, turns: [turn] });
    return Response.json({}, { status: 404 });
  });
  await pausedClock(page, new Date(created_at));
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText(waiting, { exact: true })).toBeVisible();
  const composer = page.getByLabel("Question for Doc");
  await composer.fill("Any follow-ups?");

  let requests = 0;
  await page.route(`${origin}${detailPath}`, () => {
    requests++;
  });
  const started = page.waitForRequest(`${origin}${detailPath}`);
  await page.clock.runFor(5_000);
  const request = await started;
  const aborted = page.waitForEvent("requestfailed", (failed) => failed === request);
  await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
  await aborted;
  await expect(page.getByRole("status")).toHaveText("Sign in again to open your chats.");
  await expect(page.getByText(question, { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await page.clock.runFor(15_000);
  assert.equal(requests, 1);
});

const confirmationPath = `/api/engine/doc/turns/${answeredTurn.id}/confirmation`;
const deal = { ref: { kind: "deal", id }, label: "Example deal", href: `/deals?deal=${id}` };
const savedId = "00000000-0000-4000-8000-000000000004";
const draftHref = `/inbox/card/${encodeURIComponent(`reply_draft:${savedId}`)}`;

for (const scenario of ["note", "next step", "reply", "unavailable"] as const) {
  test(`Doc confirms an edited proposal for ${scenario}`, async (t) => {
    const note = { kind: "note", target: deal, text: "A proposed note" };
    const proposal =
      scenario === "next step"
        ? { kind: "next_step", target: deal, what: "A proposed step", due_on: "2026-01-02" }
        : scenario === "reply"
          ? {
              kind: "reply_draft",
              target: { ref: { kind: "email", id }, label: "Example email", href: "/inbox" },
              subject: "A proposed subject",
              body: "A proposed reply",
            }
          : note;
    const askKey = "00000000-0000-4000-8000-000000000003";
    const turn = { ...answeredTurn, idempotency_key: askKey, answer: { ...answeredTurn.answer, proposal } };
    const attempts: { idempotency_key: string; edits: unknown }[] = [];
    let result: { kind: string; id: string; href: string; existing?: boolean } | null = null;
    let saves = 0;
    const { page, origin } = await docChatFixture(t, async (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [conversation], next_before: null });
        case detailPath:
          return Response.json({ conversation, turns: [{ ...turn, confirmation: result }] });
        case confirmationPath: {
          assert.equal(request.method, "POST");
          assert.equal(request.headers.get("x-carr-csrf"), "joe-test");
          const command: unknown = await request.json();
          assert.ok(
            command &&
              typeof command === "object" &&
              "idempotency_key" in command &&
              typeof command.idempotency_key === "string" &&
              "edits" in command,
          );
          attempts.push({ idempotency_key: command.idempotency_key, edits: command.edits });
          if (scenario === "unavailable") return Response.json({ error: "not_found" }, { status: 404 });
          if (scenario === "next step")
            return Response.json(
              { error: "open_step_exists", next_step_id: savedId, href: deal.href },
              { status: 409 },
            );
          if (!result) {
            saves++;
            result =
              scenario === "reply"
                ? { kind: "reply_draft", id: savedId, href: draftHref, existing: false }
                : { kind: "note", id: savedId, href: deal.href };
          }
          return Response.json({ result });
        }
        default:
          return Response.json({}, { status: 404 });
      }
    });
    page.setDefaultTimeout(5000);
    await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
    const target = page.getByRole("link", { name: proposal.target.label, exact: true });
    await expect(target).toHaveAttribute("href", proposal.target.href);
    const targetBox = await target.boundingBox();
    assert.ok(targetBox && targetBox.height < 44, "an in-sentence link keeps its line height");
    const card = page.locator(".doc-chat__proposal");
    const what = { note: "Note on", "next step": "Next step on", reply: "Reply to", unavailable: "Note on" }[scenario];
    await expect(card.locator(".doc-chat__proposal-for")).toHaveText(`${what} ${proposal.target.label}`);
    const accent = await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement("i"));
      probe.style.background = "var(--accent)";
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    await expect(card.getByRole("button")).toHaveCSS("background-color", accent);
    assert.equal(attempts.length, 0);
    const save = (name: string) => page.getByRole("button", { name, exact: true }).click();

    if (scenario === "next step") {
      await expect(card.getByText("Yours", { exact: true })).toBeVisible();
      await page.getByLabel("Next step", { exact: true }).fill("An edited step");
      await page.getByLabel("Due date").fill("");
      await save("Save next step");
      await expect(page.getByRole("link", { name: "Open existing next step" })).toHaveAttribute("href", deal.href);
      await expect(page.getByLabel("Next step", { exact: true })).toHaveValue("An edited step");
      assert.deepEqual(
        attempts.map(({ edits }) => edits),
        [{ what: "An edited step", due_on: null }],
      );
      assert.equal(saves, 0);
      return;
    }

    if (scenario === "reply") {
      await page.getByLabel("Subject").fill("An edited subject");
      await page.getByLabel("Reply", { exact: true }).fill("An edited reply");
      await page.route(`${origin}${draftHref}`, (route) => route.fulfill({ body: "Example reply review" }));
      await save("Save draft and open review");
      await expect(page).toHaveURL(`${origin}${draftHref}`);
      assert.deepEqual(
        attempts.map(({ edits }) => edits),
        [{ subject: "An edited subject", body: "An edited reply" }],
      );
      return;
    }

    const field = page.getByLabel("Note", { exact: true });
    await field.fill("An edited note");
    await page.reload();
    await expect(field).toHaveValue("An edited note");
    if (scenario === "unavailable") {
      await save("Save note");
      await expect(page.getByRole("alert")).toHaveText("This record is no longer available.");
      await expect(field).toHaveValue("An edited note");
      assert.equal(saves, 0);
      return;
    }

    await page.route(
      `${origin}${confirmationPath}`,
      async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort();
      },
      { times: 1 },
    );
    await save("Save note");
    await expect(page.getByRole("alert")).toHaveText("Doc couldn’t tell if this saved. Try again.");
    await expect(field).toHaveValue("An edited note");
    await expect(field).toBeDisabled();
    await expect(field).toHaveCSS("opacity", "0.55");
    assert.equal(saves, 1);
    await save("Retry save");
    const savedLine = page.locator(".doc-chat__saved");
    await expect(savedLine).toHaveText(`Saved note on ${deal.label}`);
    await expect(savedLine.locator("svg")).toBeVisible();
    await expect(card).toHaveCount(0);
    const saved = savedLine.getByRole("link", { name: deal.label, exact: true });
    await expect(saved).toHaveAttribute("href", deal.href);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(saves, 1);
    const [command] = attempts;
    assert.ok(command);
    assert.notEqual(command.idempotency_key, askKey);
    assert.deepEqual(command.edits, { text: "An edited note" });
    await page.reload();
    await expect(saved).toHaveCount(1);
    await expect(field).toHaveCount(0);
  });
}

for (const existing of [true, false]) {
  test(`Doc confirms a reply and says whether it opened the saved draft (existing: ${existing})`, async (t) => {
    const proposal = {
      kind: "reply_draft",
      target: { ref: { kind: "email", id }, label: "Example email", href: "/inbox" },
      subject: "Subject",
      body: "Reply",
    };
    const turn = {
      ...answeredTurn,
      idempotency_key: "00000000-0000-4000-8000-000000000003",
      answer: { ...answeredTurn.answer, proposal },
    };
    const result = { kind: "reply_draft", id: savedId, href: draftHref, existing };
    const { page, origin } = await docChatFixture(t, async (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [conversation], next_before: null });
        case detailPath:
          return Response.json({ conversation, turns: [turn] });
        case confirmationPath:
          return Response.json({ result });
        default:
          return Response.json({}, { status: 404 });
      }
    });
    page.setDefaultTimeout(5000);
    const chatUrl = `${origin}/doc-chats?mode=live&chat=${id}`;
    await page.route(`${origin}${draftHref}`, (route) => route.fulfill({ body: "Example reply review" }));
    await page.goto(chatUrl);
    await page.getByRole("button", { name: "Save draft and open review", exact: true }).click();
    if (!existing) {
      await expect(page).toHaveURL(`${origin}${draftHref}`);
      return;
    }
    const saved = page.locator(".doc-chat__turns li").filter({ hasText: "Opened your saved draft." });
    await expect(saved.getByText("Opened your saved draft. Doc’s new wording wasn’t used.")).toBeVisible();
    await expect(saved.getByRole("link", { name: "Open reply review" })).toHaveAttribute("href", draftHref);
    await expect(saved.locator("svg")).toHaveCount(0);
    await expect(page).toHaveURL(chatUrl);
  });
}

test("Doc shows a reply revision as a revision and confirms it with one saved line", async (t) => {
  const target = { ref: { kind: "reply_draft", id: savedId }, version: 7, href: draftHref, label: "Reply draft" };
  const proposal = { kind: "reply_revision", target, body: "A revised reply" };
  const turn = {
    ...answeredTurn,
    idempotency_key: "00000000-0000-4000-8000-000000000003",
    answer: { ...answeredTurn.answer, proposal },
  };
  const result = { kind: "reply_revision", id: savedId, href: draftHref, version: 8 };
  let saved = false;
  const { page, origin } = await docChatFixture(t, async (request) => {
    switch (new URL(request.url).pathname) {
      case "/api/engine/doc/conversations":
        return Response.json({ conversations: [conversation], next_before: null });
      case detailPath:
        return Response.json({ conversation, turns: [{ ...turn, confirmation: saved ? result : null }] });
      case confirmationPath:
        saved = true;
        return Response.json({ result });
      default:
        return Response.json({}, { status: 404 });
    }
  });
  page.setDefaultTimeout(5000);
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  const card = page.locator(".doc-chat__proposal");
  await expect(card.locator(".doc-chat__proposal-for")).toHaveText("Revision of Reply draft");
  const save = card.getByRole("button", { name: "Save revision", exact: true });
  const accent = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("i"));
    probe.style.background = "var(--accent)";
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  await expect(save).toHaveCSS("background-color", accent);
  await page.route(`${origin}${draftHref}`, (route) => route.fulfill({ body: "Example reply review" }));
  await save.click();
  await expect(page).toHaveURL(`${origin}${draftHref}`);
  await page.goBack();
  const savedLine = page.locator(".doc-chat__saved");
  await expect(savedLine).toHaveText("Saved revision of Reply draft");
  await expect(savedLine.locator("svg")).toBeVisible();
  await expect(savedLine.getByRole("link", { name: "Reply draft", exact: true })).toHaveAttribute("href", draftHref);
  await expect(card).toHaveCount(0);
});

test("Doc identifies refused reply fields and keeps edits", async (t) => {
  const proposal = {
    kind: "reply_draft",
    target: { ref: { kind: "email", id }, label: "Example email", href: "/inbox" },
    subject: "Subject",
    body: "Reply",
  };
  const turn = {
    ...answeredTurn,
    idempotency_key: "00000000-0000-4000-8000-000000000003",
    answer: { ...answeredTurn.answer, proposal },
  };
  const { page, origin } = await docChatFixture(t, async (request) => {
    switch (new URL(request.url).pathname) {
      case "/api/engine/doc/conversations":
        return Response.json({ conversations: [conversation], next_before: null });
      case detailPath:
        return Response.json({ conversation, turns: [turn] });
      case confirmationPath:
        return Response.json(
          {
            error: "invalid_field_value",
            fields: ["body"],
            hint: "Check the named fields against the tool’s documented input.",
          },
          { status: 400 },
        );
      default:
        return Response.json({}, { status: 404 });
    }
  });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  const subject = page.getByLabel("Subject");
  await expect(subject).toHaveAttribute("maxlength", "998");
  await subject.fill("Edited subject");
  const reply = page.getByLabel("Reply", { exact: true });
  await reply.fill("Edited reply");
  await page.getByRole("button", { name: "Save draft and open review" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a reply.");
  await expect(page.getByText("Check the named fields against the tool’s documented input.")).toHaveCount(0);
  await expect(reply).toHaveValue("Edited reply");
  await expect(subject).toHaveValue("Edited subject");
});

test("Recent chats pages on a phone and opens the chosen conversation", async (t) => {
  const older = { ...conversation, id: "00000000-0000-4000-8000-000000000003", title: "An older question" };
  let failOlder = true;
  const { page, origin } = await docChatFixture(t, (request) => {
    const url = new URL(request.url);
    if (url.searchParams.has("before") && failOlder) return Response.json({}, { status: 503 });
    if (url.pathname === "/api/engine/doc/conversations")
      return Response.json(
        url.searchParams.has("before")
          ? { conversations: [older], next_before: null }
          : { conversations: [conversation], next_before: id },
      );
    return Response.json({ conversation: older, turns: [] });
  });
  await page.goto(`${origin}/doc-chats?mode=live`);
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await page.getByRole("button", { name: "Older chats" }).click();
  await expect(page.getByRole("status")).toHaveText("Chats couldn’t be loaded.");
  failOlder = false;
  await page.getByRole("button", { name: "Older chats" }).click();
  await expect(page.getByRole("link", { name: older.title })).toBeVisible();
  await page.getByRole("link", { name: older.title }).click();
  await expect(page.getByLabel("Question for Doc")).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test("Ask Doc opens inside the app shell with full-size targets on a phone", async (t) => {
  const deal = {
    ref: { kind: "deal", id: "00000000-0000-4000-8000-000000000004" },
    label: "Example Clinic Lease",
    href: "/deals/00000000-0000-4000-8000-000000000004",
  };
  const { page, origin } = await docChatFixture(t, (request) =>
    new URL(request.url).pathname === "/api/engine/doc/conversations"
      ? Response.json({ conversations: [conversation], next_before: id })
      : Response.json({
          conversation,
          turns: [{ ...answeredTurn, idempotency_key: id, answer: { ...answeredTurn.answer, sources: [deal] } }],
        }),
  );
  await page.setViewportSize({ width: 1440, height: 844 });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Ask Doc / ${question}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: deal.label })).toBeVisible();
  const toolbar = page.getByRole("region", { name: "App controls" });
  const title = toolbar.getByRole("heading", { level: 1 });
  await expect(title).toHaveText(question, { useInnerText: true });
  const [recentChats, heading, newChat] = await Promise.all(
    [toolbar.getByRole("button", { name: "Recent chats" }), title, toolbar.getByRole("link", { name: "New chat" })].map(
      (control) => control.boundingBox(),
    ),
  );
  assert.ok(
    recentChats && heading && newChat && recentChats.x < heading.x && heading.x < newChat.x,
    "the top bar reads Recent chats, the chat's title, then New chat, matching Tab order",
  );
  assert.ok(
    newChat && newChat.x + newChat.width >= 390 - 12,
    `New chat sits at the right edge, ending at ${newChat?.x}`,
  );
  await expect(toolbar.locator("a:visible, button:visible")).toHaveCount(2);
  assert.equal(
    await title.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    "a title that fits is not cut short",
  );
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  const targets = page.locator("#main").locator("a:visible, button:visible");
  assert.ok((await targets.count()) >= 5);
  for (const target of await targets.all()) {
    const box = await target.boundingBox();
    assert.ok(box && box.height >= 44, `${await target.textContent()} is ${box?.height}px tall`);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

for (const [width, height] of [
  [1280, 640],
  [1440, 900],
] as const) {
  test(`A long Ask Doc chat fits one screen at its latest turn at ${width}x${height}`, async (t) => {
    const chatTitle = (index: number) => `Example question ${index + 1} about the sample clinic lease`;
    const chats = Array.from({ length: 16 }, (_, index) => ({
      ...conversation,
      id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
      title: chatTitle(index),
    }));
    const turns = Array.from({ length: 10 }, (_, index) => ({
      ...answeredTurn,
      id: `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
      position: index + 1,
      idempotency_key: id,
      question: `Example question ${index + 1}?`,
      answer: { ...answeredTurn.answer, text: `Example answer ${index + 1}.\nIt has a second line.\nAnd a third.` },
    }));
    const { page, origin } = await docChatFixture(t, async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/engine/doc/conversations")
        return Response.json({ conversations: [conversation, ...chats], next_before: null });
      if (path !== "/api/engine/doc/turns") return Response.json({ conversation, turns });
      const { question, idempotency_key } = await request.json();
      return Response.json({
        conversation_id: id,
        turn: {
          ...answeredTurn,
          id: `00000000-0000-4000-8000-${"3".repeat(12)}`,
          position: 11,
          question,
          idempotency_key,
        },
      });
    });
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
    const latest = page.getByText("Example answer 10.", { exact: false });
    await expect(latest).toBeVisible();
    assert.equal(
      await page.evaluate(() =>
        [document.scrollingElement, document.getElementById("appMainSlot")].every(
          (node) => node && node.scrollHeight <= node.clientHeight,
        ),
      ),
      true,
      "the page itself does not scroll",
    );
    const inView = async (locator: Locator) => {
      const box = await locator.boundingBox();
      return Boolean(box && box.y >= 0 && box.y + box.height <= height);
    };
    assert.equal(await inView(latest), true, "the chat opens at its latest answer");
    assert.equal(await inView(page.getByRole("button", { name: "Send", exact: true })), true, "Send stays on screen");
    assert.equal(await inView(page.getByRole("link", { name: "New chat" })), true);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Ask Doc / ${question}`);
    await expect(page.getByRole("link", { name: "Ask Doc", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
    await expect(page.getByRole("heading", { name: "Recent chats" })).toHaveCount(0);
    const chat = page.getByRole("link", { name: chatTitle(15) });
    await chat.scrollIntoViewIfNeeded();
    assert.equal(await inView(chat), true, "Recent chats scrolls inside itself");
    assert.equal(await page.evaluate(() => document.getElementById("appMainSlot")?.scrollTop), 0);
    const pane = page.locator(".doc-chat__scroll");
    const inPane = async (locator: Locator) => {
      const [box, frame] = await Promise.all([locator.boundingBox(), pane.boundingBox()]);
      return Boolean(box && frame && box.y >= frame.y && box.y + box.height <= frame.y + frame.height);
    };
    assert.equal(await inPane(latest), true);
    await pane.evaluate((node) => node.scrollTo({ top: -node.scrollHeight }));
    assert.equal(await inPane(latest), false, "the partner scrolled up the conversation");
    await page.getByLabel("Question for Doc").fill("Example follow-up question?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const sent = page.locator(".doc-chat__turns").getByText("Example follow-up question?", { exact: true });
    await expect(sent).toBeVisible();
    assert.equal(await inPane(sent), true, "a sent question shows at the bottom of the conversation");
  });
}

for (const { touch, fits } of [
  { touch: false, fits: { icon: (h: number) => h >= 28 && h <= 32, row: (h: number) => h >= 28 } },
  { touch: true, fits: { icon: (h: number) => h >= 44, row: (h: number) => h >= 44 } },
]) {
  test(`On a computer with ${touch ? "touch" : "a mouse"} the chats list takes its sizes from the pointer`, async (t) => {
    const { page, origin } = await docChatFixture(
      t,
      () => Response.json({ conversations: [conversation], next_before: null }),
      undefined,
      { viewport: { width: 1280, height: 640 }, hasTouch: touch },
    );
    await page.goto(`${origin}/doc-chats?mode=live`);
    const list = page.getByRole("complementary", { name: "Chats" });
    const height = async (locator: Locator) => Math.round((await locator.boundingBox())?.height ?? 0);
    const icon = await height(list.getByRole("link", { name: "New chat" }));
    const row = await height(list.getByRole("link", { name: question }));
    assert.ok(fits.icon(icon), `New chat is ${icon}px`);
    assert.ok(fits.row(row), `a chat row is ${row}px`);
  });
}

test("On a computer the chats list stays open, newest first, with each chat's Central time, day or date", async (t) => {
  const chats = (
    [
      ["This morning's question", "2026-11-25T15:12:00Z", "9:12 AM"],
      ["Late last night's question", "2026-11-25T05:30:00Z", "Tue"],
      ["Six days ago", "2026-11-19T18:00:00Z", "Thu"],
      ["A week ago", "2026-11-18T18:00:00Z", "Nov 18"],
      ["Last year", "2025-12-30T18:00:00Z", "Dec 30, 2025"],
    ] as const
  ).map(([title, at, shown], index) => ({
    chat: { id: `00000000-0000-4000-8000-${String(400 + index).padStart(12, "0")}`, title, created_at: at },
    shown,
  }));
  const { page, origin } = await docChatFixture(
    t,
    () => Response.json({ conversations: chats.map(({ chat }) => chat), next_before: null }),
    undefined,
    { viewport: { width: 1440, height: 900 }, hasTouch: false },
  );
  await pausedClock(page, new Date("2026-11-25T18:00:00Z"));
  await page.goto(`${origin}/doc-chats?mode=live`);
  const list = page.getByRole("complementary", { name: "Chats" });
  await expect(list.getByRole("link", { name: /^This morning's question/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recent chats", exact: true })).toBeHidden();
  await expect(list.locator(".doc-chat__chat-name")).toHaveText(chats.map(({ chat }) => chat.title));
  await expect(list.locator("time")).toHaveText(
    chats.map(({ shown }) => shown),
    { useInnerText: true },
  );
  await expect(list.getByText("Chats", { exact: true })).toHaveCount(0);
  for (const row of await list.getByRole("link").all()) {
    const box = await row.boundingBox();
    assert.ok(box && box.height <= 40, `${await row.textContent()} is one ${box?.height}px row`);
  }
  await expect(page.getByText("What do you need?")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ask Doc");
});

test("The conversation is one column: the question boxed on the right, Doc's answer plain with record chips, and the line where the answer lands", async (t) => {
  const asked = "2026-11-25T17:59:48Z";
  const turn = (n: number, fields: object) => ({
    ...answeredTurn,
    id: `00000000-0000-4000-8000-${String(500 + n).padStart(12, "0")}`,
    position: n,
    idempotency_key: `00000000-0000-4000-8000-${String(600 + n).padStart(12, "0")}`,
    created_at: asked,
    ...fields,
  });
  const sources = [
    { ref: { kind: "deal", id }, label: "Example Dental", href: `/deals?deal=${id}` },
    { ref: { kind: "client", id }, label: "Example Client", href: `/relationships?party=${id}` },
    { ref: { kind: "email", id }, label: "Lease draft timing", href: "/inbox" },
  ];
  const turns = [
    turn(1, {
      question: `${question} And which of them still need a signed lease, an updated rent roll or a tenant estoppel before they can close?`,
      answer: { ...answeredTurn.answer, sources },
      answered_by: "backup",
    }),
    turn(2, { state: "failed", answer: null }),
    turn(3, { state: "queued", answer: null, waiting_reason: "Doc answers when your Mac is on." }),
    turn(4, { state: "working", answer: null }),
  ];
  const { page, origin } = await docChatFixture(
    t,
    (request) =>
      new URL(request.url).pathname === "/api/engine/doc/conversations"
        ? Response.json({ conversations: [conversation], next_before: null })
        : Response.json({ conversation, turns }),
    undefined,
    { viewport: { width: 1440, height: 900 }, hasTouch: false },
  );
  await pausedClock(page, new Date("2026-11-25T18:00:00Z"));
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  const working = page.getByText(/^Doc is working · /);
  await expect(working).toHaveText("Doc is working · 12s");
  await expect(working).toHaveAttribute("aria-live", "off");
  await page.clock.runFor(3000);
  await expect(working).toHaveText("Doc is working · 15s");
  await expect(page.getByText("Doc couldn’t answer.")).toBeVisible();
  await expect(page.getByText("Doc answers when your Mac is on.")).toBeVisible();
  await expect(page.getByText("Answered by backup")).toBeVisible();

  const chips = page.getByRole("list", { name: "Sources" }).getByRole("link");
  await expect(chips).toHaveText(sources.map(({ label }) => label));
  for (const chip of await chips.all()) await expect(chip.locator("svg")).toHaveCount(1);

  const box = async (locator: Locator) => {
    const rect = await locator.boundingBox();
    assert.ok(rect);
    return rect;
  };
  const turnList = page.getByRole("region", { name: "Conversation" }).getByRole("list").first();
  const column = await box(turnList);
  const asking = await box(page.locator(".doc-chat__question").first());
  const answer = page.getByText(answeredTurn.answer.text, { exact: true });
  assert.equal(column.width, 728, "the conversation is a 728px column");
  assert.ok(Math.abs(asking.x + asking.width - (column.x + column.width)) <= 1, "the question sits on the right");
  assert.ok(asking.width > column.width * 0.7, "the question is long enough to need the cap");
  assert.ok(asking.width <= column.width * 0.8, "the question box is at most 80% of the column");
  assert.ok(Math.abs((await box(answer)).x - column.x) <= 1, "the answer starts at the column's left edge");
  await expect(answer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(answer).toHaveCSS("padding-left", "0px");
});

test("A failed answer has its Retry on the same line, and a short chat starts at the top", async (t) => {
  const { page, origin } = await docChatFixture(
    t,
    (request) =>
      new URL(request.url).pathname === "/api/engine/doc/conversations"
        ? Response.json({ conversations: [conversation], next_before: null })
        : Response.json({
            conversation,
            turns: [{ ...answeredTurn, idempotency_key: id, state: "failed", answer: null }],
          }),
    undefined,
    { viewport: { width: 1440, height: 900 }, hasTouch: false },
  );
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  const failed = page.getByText("Doc couldn’t answer.");
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  const line = await failed.boundingBox();
  const button = await retry.boundingBox();
  const pane = await page.locator(".doc-chat__scroll").boundingBox();
  assert.ok(line && button && pane);
  assert.ok(button.y < line.y + line.height && button.y + button.height > line.y, "Retry shares the failed line");
  assert.ok(button.x - (line.x + line.width) < 80, "Retry sits next to the failed line, not at the far edge");
  const asking = await page.locator(".doc-chat__question").boundingBox();
  assert.ok(asking && asking.y - pane.y < 24, "a short chat starts at the top of the conversation");
});

test("On a phone the chats slide in over the conversation and close from the dimmed side", async (t) => {
  const { page, origin } = await docChatFixture(t, (request) =>
    new URL(request.url).pathname === "/api/engine/doc/conversations"
      ? Response.json({ conversations: [conversation], next_before: null })
      : Response.json({ conversation, turns: [{ ...answeredTurn, idempotency_key: id }] }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  const answer = page.getByText(answeredTurn.answer.text);
  await expect(answer).toBeVisible();
  const chat = page.getByRole("link", { name: new RegExp(`^${question}`) });
  await expect(chat).toBeHidden();
  const before = await answer.boundingBox();
  const toggle = page.getByRole("button", { name: "Recent chats", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(chat).toBeFocused();
  const panel = await page.getByRole("complementary", { name: "Chats" }).boundingBox();
  assert.ok(
    panel && panel.x === 0 && panel.width < 390,
    `the chats cover the left at ${panel?.x}, ${panel?.width}px wide`,
  );
  assert.deepEqual(await answer.boundingBox(), before, "the conversation stays where it was under the chats");
  await page.mouse.click(385, 400);
  await expect(chat).toBeHidden();
  await expect(toggle).toBeFocused();
});

test("On a phone the open chats keep Tab inside them and close on Escape wherever focus is", async (t) => {
  let listArrives!: () => void;
  const listSent = new Promise<void>((resolve) => {
    listArrives = resolve;
  });
  const { page, origin } = await docChatFixture(t, async (request) => {
    if (new URL(request.url).pathname !== "/api/engine/doc/conversations") {
      return Response.json({ conversation, turns: [{ ...answeredTurn, idempotency_key: id }] });
    }
    await listSent;
    return Response.json({ conversations: [conversation], next_before: id });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  const toggle = page.getByRole("button", { name: "Recent chats", exact: true });
  // The partner opens the chats before the list has arrived.
  await toggle.click();
  listArrives();
  const list = page.getByRole("complementary", { name: "Chats" });
  const chat = list.getByRole("link", { name: new RegExp(`^${question}`) });
  const older = list.getByRole("button", { name: "Older chats" });
  const pencil = list.getByRole("link", { name: "New chat" });
  await expect(chat).toBeFocused();
  await expect(older).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(older).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(pencil).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(older).toBeFocused();
  await older.evaluate((element) => element.blur());
  await page.keyboard.press("Escape");
  await expect(chat).toBeHidden();
  await expect(toggle).toBeFocused();
});

test("On a phone Older chats keeps focus when the page it loads holds the current chat", async (t) => {
  const newer = { ...conversation, id: "00000000-0000-4000-8000-000000000003", title: "A newer question" };
  let chatArrives!: () => void;
  const chatSent = new Promise<void>((resolve) => {
    chatArrives = resolve;
  });
  const { page, origin } = await docChatFixture(t, async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/engine/doc/conversations") {
      await chatSent;
      return Response.json({ conversation, turns: [{ ...answeredTurn, idempotency_key: id }] });
    }
    return Response.json(
      url.searchParams.has("before")
        ? { conversations: [conversation], next_before: id }
        : { conversations: [newer], next_before: newer.id },
    );
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  const list = page.getByRole("complementary", { name: "Chats" });
  const older = list.getByRole("button", { name: "Older chats" });
  // Older chats waits while the current chat is still loading, and looks it.
  await expect(older).toBeDisabled();
  await expect(older).toHaveCSS("opacity", "0.55");
  await expect(older).toHaveCSS("cursor", "not-allowed");
  chatArrives();
  await expect(older).toBeEnabled();
  await expect(older).toHaveCSS("opacity", "1");
  await older.focus();
  await page.keyboard.press("Enter");
  await expect(list.getByRole("link", { name: new RegExp(`^${question}`) })).toBeVisible();
  await expect(older).toBeEnabled();
  await expect(older).toBeFocused();
});

test("A first-time partner on a phone sees no conversations yet and can send a first question", async (t) => {
  const { page, origin } = await docChatFixture(t, async (request) =>
    new URL(request.url).pathname === "/api/engine/doc/turns"
      ? Response.json({
          conversation_id: id,
          turn: { ...answeredTurn, idempotency_key: (await request.json()).idempotency_key },
        })
      : Response.json({ conversations: [], next_before: null }),
  );
  await page.goto(`${origin}/doc-chats?mode=live`);
  await expect(page.getByText("What do you need?")).toBeVisible();
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await expect(page.getByText("No conversations yet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("No conversations yet")).toBeHidden();
  await page.getByLabel("Question for Doc").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
  await expect(page.getByText("What do you need?")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(question, { useInnerText: true });
  await page.getByRole("button", { name: "Recent chats", exact: true }).click();
  await expect(page.getByRole("link", { name: question })).toBeVisible();
  await expect(page.getByText("No conversations yet")).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test("Enter sends a Doc question once and Shift+Enter starts a new line", async (t) => {
  const asks: { question: string; idempotency_key: string }[] = [];
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const { page, origin } = await docChatFixture(t, async (request) => {
    if (new URL(request.url).pathname !== "/api/engine/doc/turns")
      return Response.json({ conversations: [], next_before: null });
    const ask = await request.json();
    asks.push(ask);
    await answered;
    return Response.json({ conversation_id: id, turn: { ...answeredTurn, idempotency_key: ask.idempotency_key } });
  });
  await page.goto(`${origin}/doc-chats?mode=live`);
  const composer = page.getByLabel("Question for Doc");
  await expect(composer).toBeEnabled();

  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await composer.fill("   ");
  await composer.press("Enter");
  await expect(composer).toHaveValue("   ");

  await composer.fill("First line");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("second line");
  await expect(composer).toHaveValue("First line\nsecond line");

  const composingEnterKept = await composer.evaluate((field) =>
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }),
    ),
  );
  assert.equal(composingEnterKept, true);

  await composer.evaluate((field) => {
    for (let press = 0; press < 2; press++)
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await expect(page.getByText("Sending question…")).toBeVisible();
  await page.keyboard.press("Enter");
  answer();
  await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
  await expect(composer).toHaveValue("");
  assert.deepEqual(
    asks.map((ask) => ask.question),
    ["First line\nsecond line"],
  );
});

test("The typing box is centered on a new chat, grows with the text, and counts only from 3,500 characters", async (t) => {
  const { page, origin } = await docChatFixture(
    t,
    async (request) =>
      new URL(request.url).pathname === "/api/engine/doc/turns"
        ? Response.json({
            conversation_id: id,
            turn: { ...answeredTurn, idempotency_key: (await request.json()).idempotency_key },
          })
        : Response.json({ conversations: [], next_before: null }),
    undefined,
    { viewport: { width: 1440, height: 772 } },
  );
  await page.goto(`${origin}/doc-chats?mode=live`);
  const box = page.getByLabel("Question for Doc");
  const card = page.locator(".doc-chat__composer");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(box).toHaveAttribute("placeholder", "Ask about a deal, a lead, a client or your mail");
  const [hello, centered] = await Promise.all([page.getByText("What do you need?").boundingBox(), card.boundingBox()]);
  assert.ok(hello && centered, "the new chat shows its line and the typing box");
  assert.ok(Math.abs(centered.y + centered.height / 2 - 772 / 2) < 80, `the box sits mid-screen at ${centered.y}`);
  assert.ok(centered.y - (hello.y + hello.height) < 48, "What do you need? sits just above the box");
  const sendBox = await send.boundingBox();
  assert.ok(sendBox && sendBox.width === sendBox.height, "Send is a round icon button");
  assert.ok(
    await send.evaluate(
      (button) => parseFloat(getComputedStyle(button).borderRadius) >= button.getBoundingClientRect().width / 2,
    ),
    "Send is a circle",
  );

  const height = async () => (await box.boundingBox())?.height ?? 0;
  await box.fill("One line");
  const oneLine = await height();
  await box.fill("Line one\nLine two\nLine three\nLine four");
  assert.ok((await height()) > oneLine * 3, "the box grows as lines are added");

  const count = page.getByText("/ 4,000");
  await box.fill("a".repeat(3499));
  await expect(count).toHaveCount(0);
  await expect(box).not.toHaveAttribute("aria-describedby");
  await box.fill("a".repeat(3500));
  await expect(count).toHaveText("3,500 / 4,000");
  await expect(box).toHaveAccessibleDescription("3,500 / 4,000");
  await expect(send).toBeEnabled();
  await box.fill("a".repeat(4001));
  await expect(count).toHaveText("4,001 / 4,000");
  await expect(send).toBeDisabled();
  const colorOf = (locator: typeof count) => locator.evaluate((node) => getComputedStyle(node).color);
  await box.fill("a".repeat(3500));
  const quiet = await colorOf(count);
  await box.fill("a".repeat(4001));
  assert.notEqual(await colorOf(count), quiet, "past 4,000 characters the count turns red");

  await box.fill(Array.from({ length: 60 }, (_, line) => `Line ${line}`).join("\n"));
  const cap = 0.4 * 772;
  const capped = await box.evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight }));
  assert.ok(capped.client <= cap + 1, `the box stops growing at 40% of the screen, at ${capped.client}`);
  assert.ok(capped.scroll > capped.client, "past the cap the text scrolls inside the box");

  await box.fill("a");
  const idleSend = await send.evaluate((button) => getComputedStyle(button).backgroundColor);
  await send.hover();
  await expect.poll(() => send.evaluate((button) => getComputedStyle(button).backgroundColor)).not.toBe(idleSend);

  await box.fill(question);
  await send.click();
  await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
  await expect(box).toHaveAttribute("placeholder", "Ask Doc");
  const docked = await card.boundingBox();
  assert.ok(
    docked && 772 - (docked.y + docked.height) < 40,
    `after the first question the box sits at the bottom, at ${docked?.y}`,
  );
});

test("On a phone the typing box stays just above the bottom menu in a long chat", async (t) => {
  const turns = Array.from({ length: 8 }, (_, index) => ({
    ...answeredTurn,
    id: `00000000-0000-4000-8000-${String(400 + index).padStart(12, "0")}`,
    position: index + 1,
    idempotency_key: id,
    answer: { ...answeredTurn.answer, text: `Example answer ${index + 1}.\nIt has a second line.\nAnd a third.` },
  }));
  const { page, origin } = await docChatFixture(t, (request) =>
    new URL(request.url).pathname === "/api/engine/doc/conversations"
      ? Response.json({ conversations: [conversation], next_before: null })
      : Response.json({ conversation, turns }),
  );
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText("Example answer 8.", { exact: false })).toBeAttached();
  const menu = page.getByRole("navigation", { name: "Primary navigation" });
  for (const top of [0, 1e6]) {
    await page.evaluate((y) => scrollTo(0, y), top);
    const [card, bar] = await Promise.all([page.locator(".doc-chat__composer").boundingBox(), menu.boundingBox()]);
    assert.ok(
      card && bar && card.y + card.height <= bar.y && bar.y - (card.y + card.height) <= 24,
      `the box ends at ${card && card.y + card.height}, the menu starts at ${bar?.y}`,
    );
  }
  const field = page.getByLabel("Question for Doc");
  for (const focused of [false, true]) {
    if (focused) await field.focus();
    await page.evaluate((y) => scrollTo(0, y), 1e6);
    const card = await page.locator(".doc-chat__dock").boundingBox();
    assert.ok(card, "the typing box is on screen");
    const gap = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest(".doc-chat__dock") !== null,
      { x: card.x + 2, y: card.y + card.height + 6 },
    );
    assert.ok(gap, `nothing scrolls into view below the box${focused ? " while it is focused" : ""}`);
  }
});

for (const [status, line] of [
  ["ready", "Doc is ready on your Mac."],
  ["not_set_up", "Doc isn't set up on your Mac yet."],
  ["mac_off", "Doc answers when your Mac is on."],
  ["signed_out", "On the Mac that runs Doc, sign in again to the AI app Doc was set up with."],
  ["plan_limited", "Doc is paused until your model's plan resets."],
] as const) {
  test(`Under the typing box one line gives the Mac's status: ${status}`, async (t) => {
    const { page, origin } = await docChatFixture(
      t,
      (request) =>
        new URL(request.url).pathname === "/api/engine/doc/link"
          ? Response.json({ status })
          : Response.json({ conversations: [], next_before: null }),
      undefined,
      { viewport: { width: 1440, height: 772 } },
    );
    await page.goto(`${origin}/doc-chats?mode=live`);
    const mac = page.locator(".doc-chat__dock > p");
    await expect(mac).toHaveText(status === "not_set_up" ? `${line} Set up in Settings` : line);
    const [box, under] = await Promise.all([page.locator(".doc-chat__composer").boundingBox(), mac.boundingBox()]);
    assert.ok(box && under && under.y >= box.y + box.height, "the line sits under the typing box");
    const dot = await mac.evaluate((element) => ({
      dot: getComputedStyle(element, "::before").backgroundColor,
      text: getComputedStyle(element).color,
    }));
    assert.equal(dot.dot === dot.text, status !== "ready", "ready has the green dot and every other status a grey one");
    if (status === "not_set_up")
      await expect(mac.getByRole("link", { name: "Set up in Settings" })).toHaveAttribute("href", "/settings");
    await page.setViewportSize({ width: 390, height: 844 });
    if (status === "ready") await expect(mac).toBeHidden();
    else await expect(mac).toBeVisible();
  });
}

test("Doc uses the engine's model and waiting code on screen", async (t) => {
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/engine/doc/link")
      return Response.json({ status: "mac_off", readiness_code: "doc_signed_out", backend: "codex" });
    if (path === `/api/engine/doc/conversations/${id}`)
      return Response.json({
        conversation,
        turns: [
          { ...queuedTurn, waiting_reason: "old wording", waiting_reason_code: "doc_plan_limit", backend: "claude" },
        ],
      });
    return Response.json({ conversations: [conversation], next_before: null });
  });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByText("Doc is paused until your Claude Code plan resets.")).toBeVisible();
  await expect(page.getByText("Sign in to Codex on your Mac.")).toBeVisible();
});

test("A conversation accepts a future backend and uses neutral waiting text", async (t) => {
  const { page, origin } = await docChatFixture(t, (request) => {
    const path = new URL(request.url).pathname;
    if (path === `/api/engine/doc/conversations/${id}`)
      return Response.json({
        conversation,
        turns: [
          { ...queuedTurn, waiting_reason: "old text", waiting_reason_code: "doc_signed_out", backend: "future" },
        ],
      });
    return Response.json({ conversations: [conversation], next_before: null });
  });
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(
    page.getByText("On the Mac that runs Doc, sign in again to the AI app Doc was set up with."),
  ).toBeVisible();
});

test("A sent question accepts a future backend", async (t) => {
  const { page, origin } = await docChatFixture(t, async (request) => {
    if (new URL(request.url).pathname === "/api/engine/doc/turns") {
      const ask = await request.json();
      return Response.json({
        conversation_id: id,
        turn: { ...answeredTurn, idempotency_key: ask.idempotency_key, backend: "future" },
      });
    }
    return Response.json({ conversations: [], next_before: null });
  });
  await page.goto(`${origin}/doc-chats?mode=live`);
  await page.getByLabel("Question for Doc").fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(answeredTurn.answer.text)).toBeVisible();
});

test("The Mac status line shows nothing when its read fails and reads again when a waiting question is answered", async (t) => {
  let answer = false;
  let linkReads = 0;
  const { page, origin } = await docChatFixture(
    t,
    (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/link":
          linkReads++;
          return linkReads === 1
            ? new Response(null, { status: 503 })
            : Response.json({ status: answer ? "ready" : "mac_off" });
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [conversation], next_before: null });
        default:
          return Response.json({
            conversation,
            turns: [answer ? answered : { ...queuedTurn, waiting_reason: "Doc answers when your Mac is on." }],
          });
      }
    },
    undefined,
    { viewport: { width: 1440, height: 772 } },
  );
  await pausedClock(page, new Date(created_at));
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  const mac = page.locator(".doc-chat__dock > p");
  await expect(page.getByText("Doc answers when your Mac is on.")).toBeVisible();
  await expect.poll(() => linkReads).toBe(1);
  await expect(mac).toHaveCount(0);
  answer = true;
  await page.clock.runFor(5_000);
  await expect(page.getByText(answered.answer.text)).toBeVisible();
  await expect(mac).toHaveText("Doc is ready on your Mac.");
  assert.equal(linkReads, 2);
});

test("The Mac status line reads again when a follow-up comes back already answered", async (t) => {
  const followUp = {
    ...answeredTurn,
    id: "00000000-0000-4000-8000-000000000003",
    idempotency_key: "00000000-0000-4000-8000-000000000004",
    position: 2,
    question: "Any follow-ups?",
  };
  let asked = false;
  let linkReads = 0;
  const { page, origin } = await docChatFixture(
    t,
    (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/link":
          linkReads++;
          return Response.json({ status: asked ? "ready" : "mac_off" });
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [conversation], next_before: null });
        case "/api/engine/doc/turns":
          asked = true;
          return Response.json({ conversation_id: id, turn: followUp }, { status: 202 });
        default:
          return Response.json({ conversation, turns: asked ? [answered, followUp] : [answered] });
      }
    },
    undefined,
    { viewport: { width: 1440, height: 772 } },
  );
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  const mac = page.locator(".doc-chat__dock > p");
  await expect(mac).toHaveText("Doc answers when your Mac is on.");
  await page.getByLabel("Question for Doc").fill(followUp.question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(mac).toHaveText("Doc is ready on your Mac.");
  assert.equal(linkReads, 2);
});

for (const path of [`/doc-chats?id=${id}`, `/doc/conversations/${id}/turns/${id}`]) {
  test(`An unavailable legacy link offers a new chat: ${path}`, async (t) => {
    const { page, origin } = await docChatFixture(t, (request) =>
      new URL(request.url).pathname === "/api/engine/doc/conversations"
        ? Response.json({ conversations: [], next_before: null })
        : Response.json({}, { status: 404 }),
    );
    await page.goto(`${origin}${path}${path.includes("?") ? "&" : "?"}mode=live`);
    await expect(page.getByRole("status")).toHaveText("This older conversation wasn't kept");
    await page.getByRole("link", { name: "New chat" }).click();
    await expect(page.getByLabel("Question for Doc")).toBeEnabled();
  });
}

for (const [width, theme, conflict, unavailable] of [
  [390, "light"],
  [390, "dark"],
  [1440, "light"],
  [1440, "dark"],
  [390, "light", "version_conflict"],
  [1440, "dark", "draft_changed"],
  [390, "light", undefined, ["not_set_up", "Doc isn't set up on your Mac yet."]],
  [390, "dark", undefined, ["mac_off", "Doc answers when your Mac is on."]],
  [
    1440,
    "light",
    undefined,
    ["signed_out", "On the Mac that runs Doc, sign in again to the AI app Doc was set up with."],
  ],
  [1440, "dark", undefined, ["plan_limited", "Doc is paused until your model's plan resets."]],
  [390, "dark", undefined, ["legacy", "Sign in with DoctorCRE to talk to Doc."]],
  [1440, "light", undefined, ["read_failed", "Couldn't check whether Doc is ready."]],
] as const) {
  const scenario = unavailable ? ` with Doc link ${unavailable[0]}` : conflict ? ` after ${conflict}` : "";
  test(`Home reviews a Doc draft revision at ${width}px in ${theme}${scenario}`, async (t) => {
    const version = 7;
    const emailId = "00000000-0000-4000-8000-000000000005";
    const reviewKey = `reply_draft:${savedId}`;
    const email = { kind: "email", subject: "Floor plan request", body: "Can you send the east suite plan?" };
    const draft = { draft_id: savedId, version, subject: "Re: Floor plan request", body: "I will send the plan." };
    const field = width === 1440 && !conflict ? "subject" : "body";
    const proposed = field === "subject" ? "East suite plan" : "I can send the plan tomorrow.";
    const edited = field === "subject" ? "East suite floor plan" : "I can send the plan by noon tomorrow.";
    const result = { kind: "reply_revision", id: savedId, href: draftHref, version: version + 1 };
    const context = { kind: "reply_draft", id: savedId, version };
    const target = { ref: { kind: "reply_draft", id: savedId }, version, href: draftHref, label: "Reply draft" };
    let linkReads = 0;
    const { page, origin } = await docChatFixture(t, async (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/link":
          linkReads++;
          return unavailable?.[0] === "read_failed"
            ? new Response(null, { status: 503 })
            : Response.json({ status: unavailable?.[0] ?? "ready" });
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [], next_before: null });
        case "/api/engine/doc/turns": {
          const ask = await request.json();
          assert.deepEqual(ask.context, context);
          assert.equal(ask.conversation_id, undefined);
          return Response.json({
            conversation_id: id,
            turn: {
              ...answeredTurn,
              question: ask.question,
              idempotency_key: ask.idempotency_key,
              context: { ...context, activity_id: emailId, mailbox_user_id: id },
              draft_review: { draft_id: savedId, version, current: "pending_same" },
              answer: {
                kind: "answer",
                text: "I made the timing more specific.",
                sources: [target],
                proposal: { kind: "reply_revision", target, [field]: proposed },
              },
            },
          });
        }
        case confirmationPath: {
          const command = await request.json();
          assert.equal(request.headers.get("x-carr-csrf"), "joe-test");
          assert.deepEqual(command.edits, { [field]: edited });
          if (conflict)
            return Response.json(
              { error: conflict, version: conflict === "draft_changed" ? version : version + 1 },
              { status: 409 },
            );
          Object.assign(draft, { [field]: edited, version: result.version });
          return Response.json({ result });
        }
        default:
          return new Response(null, { status: 404 });
      }
    });
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((theme) => {
      localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme, walkthroughSeen: { joe: true } }));
    }, theme);
    // Use the app's live hostname while keeping every request on the loopback fixture.
    const app = "https://app.doctorcre.com";
    await page.route(`${app}/**`, async (route) => {
      const response = await route.fetch({ url: route.request().url().replace(app, origin), maxRedirects: 0 });
      if (unavailable?.[0] === "legacy" && new URL(route.request().url()).pathname === "/auth/session") {
        const headers = response.headers();
        delete headers["x-doctorcre-partner-sign-in"];
        await route.fulfill({ response, headers });
      } else {
        await route.fulfill({ response });
      }
    });
    await page.route("**/mcp", async (route) => {
      const {
        id,
        params: { name, arguments: args },
      } = route.request().postDataJSON();
      if (!["read-engine-home-card", "read-engine-home-draft"].includes(name))
        return route.fulfill({ json: { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "{}" }] } } });
      const payload =
        name === "read-engine-home-card"
          ? {
              item_id: reviewKey,
              source_type: "email_proposal",
              source_id: savedId,
              reply_draft_id: savedId,
              reply_draft_status: "pending",
              source_version: String(draft.version),
              source_state: "needs_attention",
              title: "Reply about the floor plan",
              base_version: `${draft.version}:0:inbox`,
              activity_at: created_at,
              section: "inbox",
              disposition: "inbox",
              unseen: false,
              snoozed_until: null,
              hold_until: null,
              kind_label: "Reply draft",
              context_label: null,
              due_on: null,
              open_url: null,
              deal_id: null,
              action_id: null,
              action_version: null,
              completed_at: null,
              waiting_version: 0,
              waiting_on: null,
              merged_source_ids: [],
            }
          : {
              ...draft,
              status: "pending",
              to: "sender@example.test",
              cc: "partner@example.test",
              attachments: [],
              source_activity: email,
              thread: [{ ...email, activity_id: emailId, happened_at: created_at, sender_name: "Maya Example" }],
            };
      assert.equal(
        name === "read-engine-home-card" ? args.item_id : args.id,
        name === "read-engine-home-card" ? reviewKey : savedId,
      );
      await route.fulfill({
        json: { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
      });
    });
    const fits = async () => {
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    };
    await page.goto(app + draftHref);
    await expect(page.getByText(email.body, { exact: true })).toBeVisible();
    await expect(page.getByText(draft.body, { exact: true })).toBeVisible();
    await fits();
    const talk = page.getByRole("link", { name: "Talk to Doc about this draft", exact: true });
    if (unavailable) {
      await expect(talk).toHaveCount(0);
      await expect.poll(() => linkReads).toBe(unavailable[0] === "legacy" ? 0 : 1);
      await expect(page.getByText(unavailable[1], { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Talk to Doc about this draft" })).toHaveCount(0);
      await fits();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Subject", exact: true })).toBeEditable();
      return;
    }
    await talk.click({ timeout: 3000 });
    await expect(page.getByRole("link", { name: "Open reply review" })).toHaveAttribute("href", draftHref);
    await page.getByLabel("Question for Doc").fill("Can you clarify when I'll send the floor plan?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const revision = page.getByRole("textbox", { name: field === "subject" ? "Subject" : "Reply", exact: true });
    await expect(revision).toHaveValue(proposed);
    await expect(page.getByRole("button", { name: "Send reply", exact: true })).toHaveCount(0);
    await fits();
    await revision.fill(edited);
    const save = page.getByRole("button", { name: "Save revision", exact: true });
    await save.click();
    if (conflict) {
      const alert = page.getByRole("alert");
      await expect(alert).toContainText(
        conflict === "version_conflict" ? "This draft has a newer revision." : "This draft is no longer pending.",
      );
      await expect(alert.getByRole("link", { name: "Open fresh review" })).toHaveAttribute("href", draftHref);
      await expect(revision).toHaveValue(edited);
      await expect(save).toBeDisabled();
      return;
    }
    await expect(page).toHaveURL(app + draftHref);
    await expect(page.getByText(edited, { exact: true })).toBeVisible();
    await expect(page.getByText(draft[field === "subject" ? "body" : "subject"], { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send reply", exact: true })).toBeVisible();
    await fits();
  });
}

for (const current of ["changed", "gone", "pending_same"] as const) {
  test(`A second Doc tab opens a failed draft turn with current status ${current}`, async (t) => {
    const version = 7;
    let draftStatus: "changed" | "gone" | "pending_same" = "pending_same";
    const { page, origin } = await docChatFixture(t, (request) => {
      switch (new URL(request.url).pathname) {
        case "/api/engine/doc/conversations":
          return Response.json({ conversations: [conversation], next_before: null });
        case detailPath:
          return Response.json({
            conversation,
            turns: [
              {
                ...answeredTurn,
                idempotency_key: id,
                state: "failed",
                answer: null,
                context: { kind: "reply_draft", id: savedId, version, activity_id: id, mailbox_user_id: id },
                draft_review: { draft_id: savedId, version, current: draftStatus },
              },
            ],
          });
        default:
          return new Response(null, { status: 404 });
      }
    });
    const chatUrl = `${origin}/doc-chats?mode=live&chat=${id}`;
    await page.goto(chatUrl);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();

    draftStatus = current;
    const secondTab = await page.context().newPage();
    await secondTab.goto(chatUrl);
    const chat = secondTab.getByRole("region", { name: "Conversation" });
    await expect(chat.getByText(question, { exact: true })).toBeVisible();
    const retry = chat.getByRole("button", { name: "Retry", exact: true });
    const freshReview = chat.getByRole("link", { name: "Open fresh review" });
    if (current === "pending_same") {
      await expect(retry).toBeVisible();
      await expect(freshReview).toHaveCount(0);
    } else {
      await expect(retry).toHaveCount(0);
      await expect(freshReview).toHaveAttribute("href", draftHref);
    }
  });
}

for (const [position, conflict, current, message] of [
  [1, "version_conflict", "changed", "This draft has a newer revision."],
  [2, "draft_changed", "gone", "This draft is no longer pending."],
] as const) {
  test(`Doc retries draft question ${position} with its original context and keeps a new unsent question`, async (t) => {
    const version = 7;
    const context = { kind: "reply_draft", id: savedId, version };
    let draftStatus: "pending_same" | typeof current = "pending_same";
    const turn = {
      ...answeredTurn,
      position,
      idempotency_key: "00000000-0000-4000-8000-000000000003",
      state: "failed",
      answer: null,
      context: { ...context, activity_id: id, mailbox_user_id: id },
    };
    const { page, origin } = await docChatFixture(t, async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/api/engine/doc/conversations") {
        if (url.searchParams.has("before"))
          return Response.json({
            conversations: [{ ...conversation, id: turn.id, title: "An older example chat" }],
            next_before: null,
          });
        return Response.json({ conversations: [conversation], next_before: id });
      }
      if (path === detailPath)
        return Response.json({
          conversation,
          turns: [{ ...turn, draft_review: { draft_id: savedId, version, current: draftStatus } }],
        });
      assert.equal(path, "/api/engine/doc/turns");
      assert.deepEqual(await request.json(), {
        question,
        idempotency_key: turn.idempotency_key,
        ...(position === 1 ? { context } : { conversation_id: id }),
      });
      draftStatus = current;
      return Response.json(
        { error: conflict, version: current === "changed" ? version + 1 : version },
        { status: 409 },
      );
    });
    await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
    const composer = page.getByLabel("Question for Doc");
    await composer.fill("One more thing to ask");
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await retry.click();
    await expect(page.getByRole("status")).toHaveText(message);
    await expect(page.getByRole("link", { name: "Open fresh review" })).toHaveAttribute("href", draftHref);
    await expect(composer).toHaveValue("One more thing to ask");
    await expect(retry).toHaveCount(0);
    await page.getByRole("button", { name: "Recent chats", exact: true }).click();
    await page.getByRole("button", { name: "Older chats" }).click();
    await expect(page.getByRole("link", { name: "An older example chat" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("link", { name: "Open fresh review" })).toBeVisible({ timeout: 3000 });
    await expect(retry).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("link", { name: "Open fresh review" })).toHaveAttribute("href", draftHref);
    await expect(retry).toHaveCount(0);
    await expect(composer).toHaveValue("One more thing to ask");
  });
}

test("A phone chat row shows both its latest message time and its attention mark", async (t) => {
  const chat = {
    ...conversation,
    title: "Which example deals are waiting on the new lease draft?",
    last_message_at: "2026-11-25T17:05:00Z",
    state: "waiting_ok",
  };
  const { page, origin } = await docChatFixture(
    t,
    () =>
      Response.json({
        conversations: [
          chat,
          {
            id: "00000000-0000-4000-8000-000000000055",
            title: "An older example",
            created_at: "2025-12-30T18:00:00Z",
            state: "waiting_ok",
          },
        ],
        next_before: null,
      }),
    undefined,
    { hasTouch: true },
  );
  await pausedClock(page, new Date("2026-11-25T18:00:00Z"));
  await page.goto(`${origin}/doc-chats?mode=live`);
  await page.getByRole("button", { name: "Recent chats" }).tap();
  const row = page.getByRole("link", { name: new RegExp(chat.title.replace("?", "")) });
  await expect(row.locator("time")).toHaveText("11:05a", { useInnerText: true });
  const older = page.getByRole("link", { name: /^An older example/ });
  await expect(older.locator("time")).toHaveText("12/30/25", { useInnerText: true });
  await expect(older.getByText("Needs your attention")).toHaveCount(1);
  await expect(row.getByText("Needs your attention")).toHaveCount(1);
  const fit = await row.evaluate((link) => {
    const title = link.firstElementChild?.getBoundingClientRect();
    const time = link.querySelector("time")?.getBoundingClientRect();
    const row = link.getBoundingClientRect();
    return title && time && row.height === 44 && title.right <= time.left && time.right <= row.right;
  });
  assert.equal(fit, true, "the title, time and mark fit on a single 44px row");
});

for (const followUp of [false, true]) {
  test(`The record picker sends the selected lead with a ${followUp ? "follow-up" : "new"} question`, async (t) => {
    const lead = { kind: "lead", id: "00000000-0000-4000-8000-000000000044" };
    const asks: unknown[] = [];
    const nextAt = "2026-01-02T00:00:00Z";
    const nextId = "00000000-0000-4000-8000-000000000055";
    const newer = { id: nextId, title: "Newer chat", created_at: nextAt };
    const { page, origin } = await docChatFixture(
      t,
      async (request) => {
        const url = new URL(request.url);
        switch (url.pathname) {
          case "/api/engine/doc/conversations":
            return Response.json({ conversations: followUp ? [newer, conversation] : [], next_before: null });
          case `/api/engine/doc/conversations/${id}`:
            return Response.json({ conversation, turns: [{ ...answeredTurn, idempotency_key: id }] });
          case "/api/engine/doc/records":
            assert.equal(url.searchParams.get("query"), "Example Dental");
            return Response.json({ records: [{ ref: lead, label: "Example Dental", city: "Example City" }] });
          case "/api/engine/doc/turns": {
            const ask = await request.json();
            asks.push(ask);
            return Response.json({
              conversation_id: id,
              turn: {
                ...answeredTurn,
                id: nextId,
                position: followUp ? 2 : 1,
                created_at: nextAt,
                state: "queued",
                answer: null,
                idempotency_key: ask.idempotency_key,
                question: ask.question,
                context: ask.context,
              },
            });
          }
          default:
            return new Response(null, { status: 404 });
        }
      },
      undefined,
      { hasTouch: !followUp, ...(followUp && { viewport: { width: 1280, height: 640 } }) },
    );
    await page.goto(`${origin}/doc-chats?mode=live${followUp ? `&chat=${id}` : ""}`);
    const picker = page.getByRole("button", { name: "Point Doc at a record" });
    await picker.click();
    const search = page.getByRole("searchbox", { name: "Find a deal, lead or client" });
    await expect(search).toBeFocused();
    const bounds = await page.getByRole("dialog").boundingBox();
    assert.ok(bounds && bounds.width <= (followUp ? 480 : 390), `Record picker is ${bounds?.width}px wide`);
    await search.fill("Example Dental");
    await page.getByRole("button", { name: /Example Dental.*Lead.*Example City/ }).click();
    const chip = page.getByRole("button", { name: "Remove Example Dental" });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(chip).toHaveCount(0);
    await picker.click();
    await search.fill("Example Dental");
    await page.getByRole("button", { name: /Example Dental.*Lead.*Example City/ }).click();
    await page.getByLabel("Question for Doc").fill("What is next?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(chip).toHaveCount(0);
    expect(asks).toEqual([
      {
        question: "What is next?",
        idempotency_key: expect.any(String),
        ...(followUp && { conversation_id: id }),
        context: lead,
      },
    ]);
    if (followUp) {
      const row = page.getByRole("complementary", { name: "Chats" }).locator("li").first();
      await expect(row.getByRole("link", { name: /^Which example deals/ })).toBeVisible();
      await expect(row.locator("time")).toHaveAttribute("datetime", nextAt);
      await expect(row.getByText("Doc is working")).toHaveCount(1);
    }
  });
}

test("A match chip shows the city and deal count and opens the exact record", async (t) => {
  const href = `/clients?record=${id}`;
  const turn = {
    ...answeredTurn,
    idempotency_key: id,
    answer: {
      kind: "clarification",
      text: "Which example client did you mean?",
      sources: [{ ref: { kind: "client", id }, label: "Example Client", href, city: "Example City", deal_count: 2 }],
      proposal: null,
    },
  };
  const { page, origin } = await docChatFixture(t, (request) =>
    new URL(request.url).pathname === "/api/engine/doc/conversations"
      ? Response.json({ conversations: [conversation], next_before: null })
      : Response.json({ conversation, turns: [turn] }),
  );
  await page.goto(`${origin}/doc-chats?mode=live&chat=${id}`);
  await expect(page.getByRole("link", { name: "Example Client · Example City · 2 deals" })).toHaveAttribute(
    "href",
    href,
  );
});

test("One sidebar read refreshes working chats from different pages", async (t) => {
  const first = { ...conversation, state: "working" };
  const second = {
    id: "00000000-0000-4000-8000-000000000055",
    title: "An older working chat",
    created_at: "2025-12-29T12:00:00Z",
    state: "working",
  };
  const reads: string[] = [];
  const { page, origin } = await docChatFixture(
    t,
    (request) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/engine/doc/conversations")) return new Response(null, { status: 404 });
      reads.push(url.pathname + url.search);
      if (url.pathname !== "/api/engine/doc/conversations") return new Response(null, { status: 404 });
      if (url.searchParams.has("before")) return Response.json({ conversations: [second], next_before: null });
      const ids = url.searchParams.get("ids")?.split(",");
      if (ids) {
        assert.deepEqual(ids, [first.id, second.id]);
        return Response.json({
          conversations: [
            { ...first, state: "waiting_ok" },
            { ...second, state: null },
          ],
          next_before: null,
        });
      }
      return Response.json({ conversations: [first], next_before: first.id });
    },
    undefined,
    { viewport: { width: 1440, height: 900 } },
  );
  await pausedClock(page, new Date("2026-11-25T18:00:00Z"));
  await page.goto(`${origin}/doc-chats?mode=live`);
  await expect(page.getByLabel("Question for Doc")).toBeEnabled();
  await page.getByRole("button", { name: "Older chats" }).click();
  const list = page.getByRole("complementary", { name: "Chats" });
  await expect(list.getByText("Doc is working", { exact: true })).toHaveCount(2);
  await page.clock.runFor(30_000);
  await expect(list.getByText("Needs your attention")).toHaveCount(1);
  await expect(list.getByText("Doc is working", { exact: true })).toHaveCount(0);
  assert.deepEqual(reads, [
    "/api/engine/doc/conversations",
    `/api/engine/doc/conversations?before=${first.id}`,
    `/api/engine/doc/conversations?ids=${encodeURIComponent([first.id, second.id].join(","))}`,
  ]);
});
