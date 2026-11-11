import assert from "node:assert/strict";
import test from "node:test";
import { exercise, resolverFixture } from "../scripts/prove-call-review-decision-replay-key.ts";
import { chromium, fixtureServer } from "./browser-harness.mjs";

for (const width of [390, 1440])
  test(`explicit decision recovery through public mount at ${width}px`, async () => {
    const server = await fixtureServer(),
      browser = await chromium.launch(),
      page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(server.origin);
      const candidateId = "10000000-0000-4000-8000-000000000001";
      assert.equal(
        (
          await page.evaluate(exercise, {
            fixtures: {
              candidateId,
              confirmed: resolverFixture(candidateId, true),
              skipped: resolverFixture(candidateId, false),
            },
          })
        ).length,
        8,
      );
    } finally {
      await page.close();
      await browser.close();
      await server.close();
    }
  });
for (const width of [390, 1440])
  for (const scenario of ["http", "refusal", "receipt"])
    test(`live adapter ${scenario} recovery at ${width}px`, async () => {
      const server = await fixtureServer(),
        browser = await chromium.launch(),
        page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(server.origin);
        const result = await page.evaluate(
          async ({ scenario, confirmed, skipped }) => {
            const { mountCallReview } = await import("/js/" + "ui-call.generated.js");
            const { createLiveClient } = await import("/js/" + "live-client.js");
            const rows = [
              {
                session_id: "synthetic-call",
                call_date: "2026-10-01",
                applied: [],
                open_cards: [
                  {
                    candidate_id: "synthetic-candidate",
                    resolver: scenario === "receipt" ? "resolve-candidate" : "resolve-post-call-candidate",
                    kind: scenario === "receipt" ? "next_step" : "assigned_action",
                    payload: { action: "Synthetic task" },
                  },
                ],
              },
            ];
            const writes: { accept: boolean; idempotency_key: string }[] = [],
              node = document.createElement("main");
            document.body.replaceChildren(node);
            const mcp = (payload: unknown, isError = false) =>
              Response.json({ result: { isError, content: [{ type: "text", text: JSON.stringify(payload) }] } });
            const client = createLiveClient({
              fetchImpl: async (path: string, init: { body: string }) => {
                if (path === "/auth/session") return Response.json({ actor: { slug: "joe" }, csrf_token: "synthetic" });
                const { name, arguments: args } = JSON.parse(init.body).params;
                if (name === "read-call-outcomes") return mcp({ calls: rows });
                writes.push(args);
                if (writes.length === 1 && scenario === "http") return new Response("", { status: 409 });
                if (writes.length === 1 && scenario === "refusal")
                  return mcp({ error: "assignee_not_provisioned" }, true);
                const row = rows[0];
                if (!row) throw Error("Missing call");
                row.open_cards = [];
                return mcp(args.accept ? confirmed : skipped);
              },
            });
            const view = mountCallReview(node, {
              sessionId: "synthetic-call",
              client: () => client,
              describe: () => "Task",
              undoRefusal: () => "",
            });
            const button = (text: string) => {
              const found = [...node.querySelectorAll("button")].find((button) => button.textContent === text);
              if (!found) throw Error(text);
              return found;
            };
            const wait = async (predicate: () => boolean) => {
              for (let i = 0; i < 100; i++) {
                if (predicate()) return;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              throw new Error("Call review did not settle");
            };
            try {
              await view.refresh();
              button("Approve or fix this item").click();
              button("Approve item").click();
              await wait(() => writes.length === 1 && !button("Refresh call review").disabled);
              if (scenario === "http") {
                if (!button("Skip item").disabled || !button("Check outcome"))
                  throw new Error("Original decision was released");
                button("Check outcome").click();
              } else if (scenario === "refusal") {
                if (button("Skip item").disabled) throw new Error("Refusal held the request");
                button("Skip item").click();
              }
              await wait(() => node.textContent.includes("No longer pending"));
              if (node.textContent.includes("outcome is unknown")) throw new Error("Successful receipt was rejected");
              return writes;
            } finally {
              view.dispose();
            }
          },
          {
            scenario,
            confirmed: resolverFixture("synthetic-candidate", true),
            skipped: resolverFixture("synthetic-candidate", false),
          },
        );
        assert.equal(result.length, scenario === "receipt" ? 1 : 2);
        if (scenario === "http") assert.deepEqual(result[1], result[0]);
        if (scenario === "refusal") {
          assert.ok(result[0] && result[1]);
          assert.equal(result[1].accept, false);
          assert.notEqual(result[1].idempotency_key, result[0].idempotency_key);
        }
      } finally {
        await page.close();
        await browser.close();
        await server.close();
      }
    });
