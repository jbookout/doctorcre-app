import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

test("installed-worker share handoff files a producer fixture and renders at phone and desktop sizes", async (t) => {
  const fixture = JSON.parse(
    await readFile(new URL("../contracts/fixtures/deal-document-intake.v1.json", import.meta.url), "utf8"),
  );
  const expected = fixture.finalize.attachment;
  let finalized = false;
  const writes: string[] = [];
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: {
      APP_ENV: "fixture",
      CARR: {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          const json = (value: unknown) =>
            new Response(JSON.stringify(value), {
              headers: { "content-type": "application/json", "cache-control": "no-store" },
            });
          if (path === "/auth/session")
            return json({ actor: { slug: "synthetic-partner" }, csrf_token: "synthetic-csrf" });
          if (path === "/mcp") {
            const body = await request.json();
            const value =
              body.params.name === "deal-room-board"
                ? { deals: [{ id: expected.deal_id, name: "Demo Harbor" }] }
                : fixture.list;
            return json({ result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
          }
          if (path.startsWith("/api/v1/deal-deliverables/")) {
            if (request.method !== "GET") {
              assert.equal(request.headers.get("x-carr-csrf"), "synthetic-csrf");
              writes.push(path);
            }
            if (path.endsWith("/bytes")) {
              assert.equal((await request.arrayBuffer()).byteLength, 7);
              return json(fixture.upload);
            }
            if (path.endsWith("/finalize")) {
              finalized = true;
              return json(fixture.finalize);
            }
            if (path.endsWith("/receipt"))
              return json(
                finalized ? fixture.finalize : { ok: true, deliverable: fixture.reserve.deliverable, attachment: null },
              );
            return json(fixture.reserve);
          }
          return new Response("Authorized synthetic gate");
        },
      },
    },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const screenshots = new URL("../out/test-artifacts/share-intake/", import.meta.url);
  await mkdir(screenshots, { recursive: true });
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      try {
        await page.addInitScript(
          (theme) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme })),
          theme,
        );
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.origin}/share-intake.html?refused=setup`);
        await page.evaluate(async () => {
          await navigator.serviceWorker.register("/sw.js", { scope: "/" });
          await navigator.serviceWorker.ready;
        });
        await page.reload();
        await Promise.all([
          page.waitForURL((url) => url.pathname === "/share-intake.html" && !url.search),
          page.evaluate(() => {
            const form = document.createElement("form");
            form.method = "POST";
            form.action = "/share-target";
            form.enctype = "multipart/form-data";
            const input = document.createElement("input");
            input.type = "file";
            input.name = "files";
            const transfer = new DataTransfer();
            transfer.items.add(
              new File([new Uint8Array([255, 216, 255, 0, 1, 2, 3])], "Photo.jpg", { type: "image/jpeg" }),
            );
            input.files = transfer.files;
            form.append(input);
            document.body.append(form);
            form.requestSubmit();
          }),
        ]);
        await page.waitForFunction(
          () => !!document.querySelector("select") || !!document.querySelector('.share-intake [role="status"] p'),
        );
        await page
          .getByLabel("Choose from available deals")
          .selectOption(expected.deal_id, { timeout: 5000 })
          .catch(async (error) => {
            throw Error(String(error) + (await page.locator("body").textContent()) + JSON.stringify(errors));
          });
        await page.getByRole("button", { name: "File document", exact: true }).waitFor();
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
        assert.equal(await page.locator("body").evaluate((node) => node.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: fileURLToPath(new URL(`${width}-${theme}.png`, screenshots)), fullPage: true });
        finalized = false;
        await page.getByRole("button", { name: "File document", exact: true }).click();
        await page.getByRole("heading", { name: "Filed", exact: true }).waitFor();
        assert.equal(
          await page.getByRole("link", { name: "Open deal", exact: true }).getAttribute("href"),
          `/deals?deal=${expected.deal_id}`,
        );
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    }
  assert.equal(writes.filter((path) => path.endsWith("/finalize")).length, 4);
});
