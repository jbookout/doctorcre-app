import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { parseDeliverableList } from "../src/ui/deal-deliverable-contract.ts";
import { chromium } from "./browser-harness.mjs";

test("deal chooser and desktop drop reconcile one private file and versioned designation at four sizes", async (t) => {
  const fixture = JSON.parse(
    await readFile(new URL("../contracts/fixtures/deal-document-intake.v1.json", import.meta.url), "utf8"),
  );
  const deal = fixture.finalize.deliverable.deal_id;
  const envelope = (v: Record<string, unknown>) => ({ ...v, schema_version: "deal-deliverables.v1" });
  let row = { ...fixture.finalize.deliverable },
    saved = false,
    failList = false,
    failReadback = false,
    lost = false,
    conflict = false,
    loseVisibility = false;

  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const assets = await appAssetSnapshot();
  assets.set("/share-intake.html", {
    contentType: "text/html",
    body: Buffer.from(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/pipeline.css"><link rel="stylesheet" href="/css/deliverable-fixture.css"></head><body><main><div id="panel"></div></main><script type="module" src="/js/deliverable-fixture.js"></script></body></html>`,
    ),
  });
  assets.set("/js/deliverable-fixture.js", {
    contentType: "text/javascript",
    body: Buffer.from(
      `import {mountDealDocuments} from '/js/ui-deal-documents.js';window.deliverablesHandle=mountDealDocuments(document.querySelector('#panel'),{dealId:'${deal}',client:{listDealDocuments:async()=>({ok:true,schema_version:'deal-documents.v1',documents:[],has_more:false,next_cursor:null})}});`,
    ),
  });
  assets.set("/css/deliverable-fixture.css", {
    contentType: "text/css",
    body: Buffer.from("main {max-width:960px;margin:auto;padding:16px}"),
  });
  const server = await startWorkerFixture({
    assets,
    env: {
      APP_ENV: "fixture",
      CARR: {
        async fetch(request: Request) {
          const path = new URL(request.url).pathname;
          const json = (value: unknown, status = 200) =>
            new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
          if (path === "/auth/session") return json({ actor: { slug: "joe" }, csrf_token: "synthetic-session" });
          if (path === "/mcp")
            return json({
              result: {
                content: [{ type: "text", text: JSON.stringify({ deals: [{ id: deal, name: "Demo Harbor" }] }) }],
              },
            });
          if (request.method === "GET" && !path.endsWith("/receipt")) {
            if (failList) return json({}, 503);
            const value = { ok: true, schema_version: "deal-deliverables.v1", deliverables: saved ? [row] : [] };
            parseDeliverableList(value, deal);
            return json(value);
          }
          if (path.endsWith("/receipt"))
            return json(envelope(saved ? { ...fixture.finalize, deliverable: row } : { ...fixture.reserve }));
          const body = request.method === "PUT" ? {} : await request.json();
          writes.push({ path, body });
          assert.equal(request.headers.get("x-carr-csrf"), "synthetic-session");
          if (path.endsWith("/bytes")) return json(fixture.upload);
          if (path.endsWith("/finalize")) {
            saved = true;
            if (!lost) {
              lost = true;
              return json({}, 503);
            }
            return json(envelope(fixture.finalize));
          }
          if (path.endsWith("/visibility")) {
            assert.equal(body.expected_version, row.version);
            if (conflict) return json({}, 409);
            row = { ...row, visibility: body.visibility, version: row.version + 1 };
            if (failReadback) failList = true;
            if (loseVisibility) {
              loseVisibility = false;
              return json({}, 503);
            }
            return json({ ok: true, schema_version: "deal-deliverables.v1", deliverable: row });
          }
          assert.equal(body.target_collection, "deliverables");
          return json(envelope(fixture.reserve));
        },
      },
    },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR586.S3.J10-shots", { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      saved = false;
      failList = false;
      failReadback = false;
      lost = false;
      conflict = false;
      row = { ...fixture.finalize.deliverable };
      writes.length = 0;
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      try {
        await page.addInitScript((theme) => {
          document.addEventListener("DOMContentLoaded", () => (document.documentElement.dataset.theme = theme));
        }, theme);
        let chooserCount = 0;
        page.on("filechooser", () => chooserCount++);
        await page.goto(`${server.origin}/share-intake.html`);
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        const panel = page.getByRole("region", { name: "Deal Deliverables", exact: true });

        await panel.getByText("No deliverables yet.", { exact: false }).waitFor();
        const keyboardButton = panel.getByRole("button", { name: /Drop one file here/ });
        assert.equal(await keyboardButton.isEnabled(), true);
        await keyboardButton.focus();
        assert.equal(await keyboardButton.evaluate((element) => element === document.activeElement), true);
        await keyboardButton.evaluate((element) => {
          element.addEventListener("click", (event) =>
            element.setAttribute("data-trusted-click", String(event.isTrusted)),
          );
        });
        const keyboardChooser = page.waitForEvent("filechooser");
        await page.keyboard.press("Enter");
        await (await keyboardChooser).setFiles([]);
        assert.equal(await keyboardButton.getAttribute("data-trusted-click"), "true");
        await keyboardButton.focus();
        const spaceChooser = page.waitForEvent("filechooser");
        await page.keyboard.press("Space");
        await (await spaceChooser).setFiles({ name: "bad.html", mimeType: "text/html", buffer: Buffer.from("bad") });
        assert.equal(chooserCount, 2);
        await panel.getByText("Failed.", { exact: false }).waitFor();
        assert.equal(writes.length, 0);
        const file = { name: "Photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from([255, 216, 255, 0, 1, 2, 3]) };
        if (width === 1440) {
          await panel.getByRole("button", { name: /Drop one file here/ }).evaluate((element) => {
            const transfer = new DataTransfer();
            transfer.items.add(
              new File([new Uint8Array([255, 216, 255, 0, 1, 2, 3])], "Photo.jpg", { type: "image/jpeg" }),
            );
            element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
          });
        } else await panel.getByLabel("Choose a deliverable", { exact: true }).setInputFiles(file);
        page.once("dialog", (dialog) => dialog.dismiss());
        assert.equal(await page.evaluate("window.deliverablesHandle.confirmLeave()"), false);
        await panel.getByRole("button", { name: "Upload to this deal", exact: true }).click();
        await panel.getByText("Unknown.", { exact: false }).waitFor();
        await page.reload();
        await panel.getByRole("button", { name: "Reconcile upload" }).click();
        await panel.getByText("Confirmed.", { exact: false }).waitFor();
        assert.equal(writes.filter((w) => w.body.target_collection).length, 1);
        assert.equal(writes.filter((w) => w.path.endsWith("/finalize")).length, 1);
        failReadback = true;
        const expectedVersion = row.version + 1;
        await panel.getByRole("button", { name: "Mark Photo.jpg shared" }).click();
        await panel.getByText("Request unavailable or version changed.", { exact: false }).waitFor();
        const refresh = panel.getByRole("button", { name: "Refresh deliverables", exact: true });
        assert.equal(await refresh.isEnabled(), true);
        await panel.getByText("Designation unconfirmed.", { exact: false }).waitFor();
        assert.equal(await panel.getByLabel("Choose a deliverable", { exact: true }).isDisabled(), true);
        assert.equal(await panel.getByRole("button", { name: /Drop one file here/ }).isDisabled(), true);
        const visibilityCount = () => writes.filter((w) => w.path.endsWith("/visibility")).length;
        assert.equal(visibilityCount(), 1);
        await page.screenshot({ path: `/tmp/WR586.S3.J10-shots/${width}-${theme}-unknown.png`, fullPage: true });
        await refresh.click();
        await panel.getByText("Request unavailable or version changed.", { exact: false }).waitFor();
        assert.equal(await refresh.isEnabled(), true);
        assert.equal(visibilityCount(), 1);
        failList = false;
        failReadback = false;
        await refresh.click();
        await panel
          .getByText(`Shared · ready for publication · Version ${expectedVersion}`, { exact: false })
          .waitFor();
        assert.equal(await panel.getByRole("button", { name: "Make Photo.jpg private" }).isEnabled(), true);
        assert.equal(await panel.getByLabel("Choose a deliverable", { exact: true }).isEnabled(), true);
        assert.equal(await panel.getByRole("button", { name: /Drop one file here/ }).isEnabled(), true);
        assert.equal(visibilityCount(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `/tmp/WR586.S3.J10-shots/${width}-${theme}-recovered.png`, fullPage: true });
        conflict = true;
        await panel.getByRole("button", { name: "Make Photo.jpg private" }).click();
        await panel.getByText("Designation unconfirmed.", { exact: false }).waitFor();
        assert.equal(await panel.getByLabel("Choose a deliverable", { exact: true }).isDisabled(), true);
        await panel.getByRole("button", { name: "Refresh deliverables" }).click();
        await panel.getByRole("button", { name: "Make Photo.jpg private" }).waitFor();
        conflict = false;
        loseVisibility = true;
        await panel.getByRole("button", { name: "Make Photo.jpg private" }).click();
        await panel.getByText("Designation unconfirmed.", { exact: false }).waitFor();
        await panel.getByRole("button", { name: "Refresh deliverables" }).click();
        await panel.getByRole("button", { name: "Mark Photo.jpg shared" }).waitFor();

        await panel.getByRole("button", { name: "Mark Photo.jpg shared" }).click();
        await panel.getByRole("button", { name: "Make Photo.jpg private" }).click();
        await panel.getByRole("button", { name: "Mark Photo.jpg shared" }).waitFor();
        await panel.getByLabel("Choose a deliverable", { exact: true }).setInputFiles(file);
        await panel.getByRole("button", { name: "Upload to this deal" }).waitFor();
        await panel.getByRole("button", { name: "Discard pending file" }).click();
        await panel.getByText("File discarded.", { exact: false }).waitFor();
        assert.equal(writes.filter((w) => w.body.target_collection).length, 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `/tmp/WR586.S3.J10-shots/${width}-${theme}.png`, fullPage: true });
        await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
        await page.getByText("Session expired. Sign in again to view documents.", { exact: true }).waitFor();
        assert.equal(await panel.count(), 0);
      } finally {
        await page.close();
      }
    }
});
