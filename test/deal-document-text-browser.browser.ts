import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { buildArtifact } from "../scripts/artifact.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import type { TextRequest } from "../src/ui/deal-document-text.ts";
import { chromium, componentDocument } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (name: string) =>
  JSON.parse(await readFile(new URL(`./fixtures/deal-document-text/${name}.json`, import.meta.url), "utf8"));
const produced = await read("produced");
const source = {
  id: produced.attachment_id,
  display_name: "Synthetic Lease <exact>.pdf",
  document_type: "application/pdf",
  page_count: 2,
  content_hash: produced.content_hash,
  stored_at: "2026-01-01T00:00:00Z",
};
async function resolve(page: Page, value: unknown) {
  await page.evaluate((value) => window.textTest.resolve(value), value);
}
async function settle(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

test("viewer lifecycle and request identity transitions", async (t) => {
  const artifact = temporaryDirectory("doctorcre-text-", t);
  await buildArtifact({ root, outDir: artifact, commit: "1".repeat(40) });
  const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${artifact}/site` } });
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  async function setup(hash = source.content_hash) {
    const page = await browser.newPage();
    await componentDocument(page, server.url, {
      headers: { "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" },
      html: '<!doctype html><html lang="en"><title>Document text fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><body><main></main></body></html>',
      dispose: (page) => page.evaluate(() => window.textTest?.dispose()),
    });
    await page.evaluate(
      async ({ source, deal }) => {
        const path = "/js/ui-deal-documents.generated.js";
        const { mountDealDocuments } = await import(path);
        const target = document.querySelector("main");
        const pending: { resolve(value: unknown): void; reject(value: unknown): void }[] = [];
        const requests: TextRequest[] = [],
          signals: AbortSignal[] = [];
        const panel = mountDealDocuments(target, {
          dealId: deal,
          client: {
            async listDealDocuments() {
              return {
                ok: true,
                schema_version: "deal-documents.v1",
                documents: [
                  source,
                  { ...source, id: "00000000-0000-4000-8000-000000000099", display_name: "Second LOI.pdf" },
                ],
                has_more: false,
                next_cursor: null,
              };
            },
            readDealDocumentText(args: TextRequest, { signal }: { signal: AbortSignal }) {
              requests.push(args);
              signals.push(signal);
              return new Promise((resolve, reject) => pending.push({ resolve, reject }));
            },
          },
        });
        window.textTest = {
          requests,
          signals,
          resolveAt(index, value) {
            pending.splice(index, 1)[0]?.resolve(value);
          },
          rejectAt(index, value) {
            pending.splice(index, 1)[0]?.reject(value);
          },
          resolve(value) {
            pending.shift()?.resolve(value);
          },
          reject(value) {
            pending.shift()?.reject(value);
          },
          dispose() {
            panel.dispose();
          },
        };
      },
      { source: { ...source, content_hash: hash }, deal: produced.deal_id },
    );
    await page.getByRole("button", { name: `Open text for ${source.display_name}`, exact: true }).waitFor();
    return page;
  }
  async function open(page: Page) {
    await page.getByRole("button", { name: `Open text for ${source.display_name}`, exact: true }).click();
    await page.getByText("Loading document text…", { exact: true }).waitFor();
  }
  await t.test("Open Produced Navigate and Close preserve exact source addresses", async () => {
    const page = await setup();
    try {
      await open(page);
      await resolve(page, produced);
      await page.locator('[data-text-line="1"] pre').waitFor();
      assert.equal(await page.getByRole("heading", { name: source.display_name, exact: true }).count(), 2);
      assert.equal(await page.locator('[data-text-line="1"] pre').textContent(), "first");
      assert.deepEqual(await page.evaluate(() => window.textTest.requests[0]), {
        deal_id: produced.deal_id,
        attachment_id: source.id,
        content_hash: source.content_hash,
      });
      await page.getByRole("button", { name: "Read next chunk", exact: true }).click();
      assert.equal(await page.locator("[data-text-line]").count(), 0);
      assert.deepEqual(await page.evaluate(() => window.textTest.requests[1]), {
        deal_id: produced.deal_id,
        attachment_id: source.id,
        ...produced.next,
      });
      await page.getByRole("button", { name: "Close document text", exact: true }).click();
      assert.equal(await page.evaluate(() => window.textTest.signals[1]?.aborted), true);
      await resolve(page, produced);
      await settle(page);
      assert.equal(await page.getByRole("region", { name: "Document text", exact: true }).count(), 0);
    } finally {
      await page.close();
    }
  });
  for (const name of ["not-produced", "no_text", "unavailable", "failure", "changed"]) {
    await t.test(`Failed NoTextFound Changed Retry Close ${name}`, async () => {
      const availability = ["not-produced", "no_text", "unavailable"].includes(name)
        ? await read(name === "no_text" ? "no-text-current" : name === "unavailable" ? "unsupported-current" : name)
        : null;
      const page = await setup(availability?.content_hash);
      try {
        await open(page);
        if (name === "failure") await page.evaluate(() => window.textTest.reject(new Error("Synthetic failure")));
        else if (name === "changed")
          await page.evaluate(() => window.textTest.reject({ payload: { error: "source_changed" } }));
        else await resolve(page, availability);
        if (name === "changed") {
          await page.getByText("The original document changed.", { exact: false }).waitFor();
          assert.equal(await page.getByRole("button", { name: "Retry document text", exact: true }).count(), 0);
        } else {
          const message =
            name === "not-produced"
              ? "Retained text is not ready for this document."
              : name === "no_text"
                ? "This document has no text layer."
                : name === "unavailable"
                  ? "Text is unavailable for this file type or extraction limits."
                  : "Document text could not be read.";
          await page.getByText(message, { exact: true }).waitFor();
          await page.getByRole("button", { name: "Retry document text", exact: true }).click();
          await resolve(page, availability ?? produced);
          if (availability) await page.getByText(message, { exact: true }).waitFor();
          else await page.locator("[data-text-line]").first().waitFor();
        }
        await page.getByRole("button", { name: "Close document text", exact: true }).click();
        assert.equal(await page.locator("[data-text-line]").count(), 0);
      } finally {
        await page.close();
      }
    });
  }
  for (const kind of ["loading", "ready", "unavailable", "no_text", "source_changed", "closed"]) {
    for (const action of ["Retire", "Switch", "Close"])
      await t.test(`${action} and Late from ${kind}, NoCrossIdentity NoPostExpiryText`, async () => {
        const page = await setup();
        try {
          if (kind !== "closed") {
            await open(page);
            if (kind === "ready") {
              await resolve(page, produced);
              await page.locator("[data-text-line]").first().waitFor();
            }
            if (kind === "unavailable") {
              await page.evaluate(() => window.textTest.reject({}));
              await page.getByRole("button", { name: "Retry document text" }).waitFor();
            }
            if (kind === "no_text") {
              await resolve(page, await read("no-text-current"));
              await page.getByText("This document has no text layer.", { exact: true }).waitFor();
            }
            if (kind === "source_changed") {
              await page.evaluate(() => window.textTest.reject({ payload: { error: "source_changed" } }));
              await page.getByText("The original document changed.", { exact: false }).waitFor();
            }
          }
          if (action === "Retire")
            await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
          if (action === "Close" && kind !== "closed")
            await page.getByRole("button", { name: "Close document text", exact: true }).click();
          if (action === "Switch")
            await page.getByRole("button", { name: "Open text for Second LOI.pdf", exact: true }).click();
          if (kind === "loading") {
            assert.equal(await page.evaluate(() => window.textTest.signals[0]?.aborted), true);
            await resolve(page, produced);
            await settle(page);
          }
          assert.equal(await page.locator("[data-text-line]").count(), 0);
          if (action === "Switch") {
            await resolve(page, await read("second-document"));
            await page.locator("[data-text-line]").first().waitFor();
            assert.equal(
              await page
                .getByRole("region", { name: "Document text", exact: true })
                .getByRole("heading", { name: "Second LOI.pdf", exact: true })
                .count(),
              1,
            );
          }
        } finally {
          await page.close();
        }
      });
  }
  for (const width of [390, 1024, 1440])
    for (const theme of ["light", "dark"]) {
      await t.test(`Page Navigate Unicode continuation keyboard and axe ${width} ${theme}`, async () => {
        const page = await setup();
        try {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
          await page.addStyleTag({ url: server.url + "/css/app.css" });
          await page.getByRole("button", { name: `Open text for ${source.display_name}`, exact: true }).focus();
          await page.keyboard.press("Enter");
          await resolve(page, await read("full"));
          await page.locator('[data-text-line="2"]').waitFor();
          assert.deepEqual(await page.locator("[data-text-line] pre").allTextContents(), [
            "first",
            "",
            "last",
            "",
            "😀second",
          ]);
          await page.getByRole("spinbutton", { name: "Page", exact: true }).fill("2");
          await page.getByRole("button", { name: "Read page", exact: true }).click();
          await resolve(page, await read("split"));
          await page.getByText("Line 1 (continues)", { exact: true }).waitFor();
          await page.getByRole("button", { name: "Read next chunk", exact: true }).focus();
          await page.keyboard.press("Enter");
          await resolve(page, await read("continuation"));
          await page.getByText("Line 1", { exact: true }).waitFor();
          assert.equal(await page.locator("[data-text-line] pre").textContent(), "😀second");
          assert.equal(await page.locator("[data-text-line]").count(), 1);
          assert.deepEqual(await page.evaluate(() => window.textTest.requests.at(-1)), {
            deal_id: produced.deal_id,
            attachment_id: source.id,
            content_hash: source.content_hash,
            page: 2,
            line: 1,
            offset: 1,
          });
          await page.route("**/fixture-axe.js", (route) =>
            route.fulfill({ contentType: "application/javascript", path: root + "node_modules/axe-core/axe.min.js" }),
          );
          await page.addScriptTag({ url: server.url + "/fixture-axe.js" });
          const violations = await page.evaluate(async () => {
            const axe: unknown = Reflect.get(window, "axe");
            if (typeof axe !== "object" || axe === null || !("run" in axe) || typeof axe.run !== "function")
              throw Error("Axe did not load");
            return (await axe.run(document.querySelector("main"))).violations;
          });
          assert.deepEqual(violations, []);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
          await page.getByRole("button", { name: "Close document text", exact: true }).focus();
          await page.keyboard.press("Enter");
          assert.equal(await page.locator("[data-text-line]").count(), 0);
        } finally {
          await page.close();
        }
      });
    }
  for (const status of [401, 403])
    await t.test(`Retire on authorization ${status} refuses old text`, async () => {
      const page = await setup();
      try {
        await open(page);
        await page.evaluate((status) => window.textTest.reject({ status }), status);
        await page.getByText("Session expired. Sign in again to view document text.", { exact: true }).waitFor();
        assert.equal(await page.locator("[data-text-line]").count(), 0);
        assert.equal(await page.getByRole("button", { name: "Retry document text" }).count(), 0);
      } finally {
        await page.close();
      }
    });
  await t.test("Dispose and deal switch abort pending read and refuse late text", async () => {
    const page = await setup();
    try {
      await open(page);
      await page.evaluate(() => window.textTest.dispose());
      assert.equal(await page.evaluate(() => window.textTest.signals[0]?.aborted), true);
      await resolve(page, produced);
      await settle(page);
      assert.equal(await page.locator("[data-text-line]").count(), 0);
    } finally {
      await page.close();
    }
  });
  for (const destination of ["loading", "ready", "unavailable", "no_text", "source_changed", "closed", "expired"]) {
    await t.test(`Late result is ignored in ${destination}`, async () => {
      const page = await setup();
      try {
        await open(page);
        await page.getByRole("button", { name: "Open text for Second LOI.pdf", exact: true }).click();
        if (destination === "ready") {
          await page.evaluate((value) => window.textTest.resolveAt(1, value), await read("second-document"));
          await page.locator("[data-text-line]").first().waitFor();
        }
        if (destination === "no_text") {
          await page.evaluate((value) => window.textTest.resolveAt(1, value), await read("no-text-second"));
          await page.getByText("This document has no text layer.", { exact: true }).waitFor();
        }
        if (["unavailable", "source_changed"].includes(destination)) {
          await page.evaluate(
            (destination) =>
              window.textTest.rejectAt(
                1,
                destination === "source_changed" ? { payload: { error: "source_changed" } } : {},
              ),
            destination,
          );
          await page
            .getByText(
              destination === "source_changed" ? "The original document changed." : "Document text could not be read.",
              { exact: false },
            )
            .waitFor();
        }
        if (destination === "closed")
          await page.getByRole("button", { name: "Close document text", exact: true }).click();
        if (destination === "expired")
          await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
        const before = await page.locator("main").textContent();
        await resolve(page, produced);
        await settle(page);
        assert.equal(await page.locator("main").textContent(), before);
        assert.equal(await page.evaluate(() => window.textTest.signals[0]?.aborted), true);
      } finally {
        await page.close();
      }
    });
  }
});
