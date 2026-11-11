import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer as fixtureServer } from "./fixture-probe.ts";

for (const width of [390, 1024, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`quote selection and next ask at ${width} ${theme}`, async (t) => {
      const server = await fixtureServer();
      t.after(() => server.close());
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme, hasTouch: true });
      const bundle = await build({
        stdin: {
          contents: `import {createRoot} from 'react-dom/client'; import {DocumentTextViewer} from './src/ui/deal-document-text-viewer'; window.mountQuote=(host,source,value,client)=>{ const root=createRoot(host); root.render(<DocumentTextViewer source={source} client={{readDealDocumentText:async()=>value}} quoteClient={client} onClose={()=>root.unmount()}/>); };`,
          loader: "tsx",
          resolveDir: process.cwd(),
        },
        bundle: true,
        jsx: "automatic",
        format: "esm",
        write: false,
      });
      const output = bundle.outputFiles[0];
      assert.ok(output);
      await page.route("**/quote-test.js", (route) =>
        route.fulfill({ contentType: "text/javascript", body: output.text }),
      );
      await page.goto(`${server.origin}/conversations`);
      await page.addScriptTag({ type: "module", url: `${server.origin}/quote-test.js` });
      await page.waitForFunction(() => typeof window.mountQuote === "function");
      const fixture = JSON.parse(
        await readFile(new URL("./fixtures/deal-document-text/full.json", import.meta.url), "utf8"),
      );
      await page.evaluate(
        async ({ fixture, theme, width }) => {
          document.documentElement.dataset.theme = theme;
          const fixturePath = "/js/fixture-client.js";
          const { createFixtureClient } = await import(fixturePath);
          const client: QuoteTestClient = await createFixtureClient();
          const submit = client.submitDocRequest.bind(client);
          let calls = 0;
          client.submitDocRequest = async (request, actor) => {
            calls++;
            window.quoteRequests ??= [];
            window.quoteRequests.push({ ...request });
            if (width === 1024 && theme === "light" && calls === 1) {
              await submit(request, actor);
              throw Error("lost receipt");
            }
            return submit(request, width === 1440 && theme === "dark" && calls === 1 ? "wrong actor" : actor);
          };
          const host = document.createElement("section");
          host.id = "quote-test";
          document.querySelector("main")?.replaceChildren(host);
          window.mountQuote(
            host,
            {
              deal_id: fixture.deal_id,
              attachment_id: fixture.attachment_id,
              content_hash: fixture.content_hash,
              filename: "Synthetic lease.pdf",
            },
            fixture,
            client,
          );
        },
        { fixture, theme, width },
      );
      const host = page.locator("#quote-test");
      const select = host.getByRole("button", { name: "Select line 1", exact: true }).first();
      if (width === 390) await select.tap();
      else await select.press("Enter");
      const comment = host.getByRole("textbox", { name: "Comment on excerpt" });
      await comment.fill("Discard on selection change");
      await select.press("Space");
      assert.equal(await comment.inputValue(), "");
      await host.getByRole("button", { name: "End at line 3", exact: true }).first().press("Enter");
      await comment.fill("Known synthetic comment");
      await host.getByRole("button", { name: "Choose conversation", exact: true }).click();
      const picker = host.getByRole("combobox", { name: "Conversation for next ask" });
      await picker.waitFor();
      const id = await picker.locator("option").nth(1).getAttribute("value");
      assert.ok(id);
      await picker.selectOption(id);
      const input = host.getByRole("textbox", { name: "Ask Dr. CRE", exact: true });
      await input.waitFor();
      await input.fill("Existing ask");
      await page.waitForFunction(() =>
        Object.keys(localStorage).some(
          (key) => key.endsWith(":draft") && JSON.parse(localStorage.getItem(key) ?? "{}").text === "Existing ask",
        ),
      );
      const preview = await host.getByLabel("Excerpt preview").textContent();
      assert.ok(preview);
      const useQuote = host.getByRole("button", { name: "Use in next ask", exact: true });
      if (width === 1440 && theme === "light") {
        await page.evaluate(() => {
          window.originalSetItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key.endsWith(":draft")) throw Error("synthetic quota");
            return window.originalSetItem.call(this, key, value);
          };
        });
        await useQuote.click();
        await host.getByText("synthetic quota", { exact: true }).waitFor();
        assert.equal(await input.inputValue(), "Existing ask");
        assert.equal(await comment.inputValue(), "Known synthetic comment");
        await page.evaluate(() => {
          Storage.prototype.setItem = window.originalSetItem;
        });
        await page.evaluate(() => {
          const key = Object.keys(localStorage).find((key) => key.endsWith(":draft"));
          if (!key) throw Error("Missing saved draft");
          localStorage.setItem(key, JSON.stringify({ text: "Other tab draft", version: 500 }));
        });
        await useQuote.click();
        await host
          .getByText("The draft changed in another tab. Reopen it before inserting.", { exact: true })
          .waitFor();
        assert.equal(await input.inputValue(), "Existing ask");
        await picker.selectOption("");
        await picker.selectOption(id);
        await input.waitFor();
        assert.equal(await input.inputValue(), "Other tab draft");
        await input.fill("Existing ask");
      }
      await useQuote.click({ trial: true });
      await useQuote.evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw Error("Missing insert button");
        button.click();
        button.click();
      });
      await page.waitForFunction(
        (expected) => document.querySelector<HTMLTextAreaElement>("#quote-test #askText")?.value === expected,
        `Existing ask\n\n${preview}`,
      );
      await page.waitForFunction(
        (expected) => document.querySelector<HTMLTextAreaElement>("#quote-test #askText")?.value === expected,
        `Existing ask\n\n${preview}`,
      );
      assert.equal(await input.inputValue(), `Existing ask\n\n${preview}`);
      assert.equal(await useQuote.isDisabled(), true);
      assert.equal(await input.evaluate((node) => node === document.activeElement), true);
      await comment.fill("Changed after insertion");
      await page.waitForFunction(
        (expected) => document.querySelector<HTMLTextAreaElement>("#quote-test #askText")?.value === expected,
        `Existing ask\n\n${preview}`,
      );
      assert.equal(await input.inputValue(), `Existing ask\n\n${preview}`);
      await page.context().setOffline(true);
      await host.getByRole("button", { name: "Send ask", exact: true }).click();
      await host.getByText("Saved on this device. Waiting for a connection.", { exact: true }).waitFor();
      await page.context().setOffline(false);
      if (width === 1024 && theme === "light") {
        await host.getByText("Receipt not confirmed. Your ask is kept here.", { exact: true }).waitFor();
        await host.getByRole("button", { name: "Check receipt", exact: true }).click();
      }
      if (width === 1440 && theme === "dark") {
        await host.getByText("Your ask was declined. It is kept here.", { exact: true }).waitFor();
        await host.getByRole("button", { name: "Try again", exact: true }).click();
      }
      await host.getByText("Received by Dr. CRE. An answer is still pending.", { exact: true }).waitFor();
      assert.equal(await host.locator(".work-list li p").first().textContent(), `Existing ask\n\n${preview}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.addScriptTag({
        content: await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8"),
      });
      const violations = await page.evaluate(
        async () => (await window.axe.run(document.querySelector("#quote-test"))).violations,
      );
      assert.deepEqual(
        violations.map((v) => v.id),
        [],
      );
      const requests = await page.evaluate(() => window.quoteRequests);
      assert.ok(requests.length >= 1);
      assert.ok(requests.every((r) => JSON.stringify(r) === JSON.stringify(requests[0])));
      assert.equal(requests[0]?.body, `Existing ask\n\n${preview}`);
      await page.screenshot({ path: `/tmp/WR617.S9.J13-${width}-${theme}.png`, fullPage: true });
      await page.goto(`${server.origin}/conversations?id=${id}`);
      await page.getByRole("textbox", { name: "Ask Dr. CRE", exact: true }).waitFor();
      await page.getByText("Received by Dr. CRE. An answer is still pending.", { exact: true }).waitFor();
      assert.equal(
        await page.locator("#askComposer .work-list li p").first().textContent(),
        `Existing ask\n\n${preview}`,
      );
    });

test("viewer source replacement, Unicode continuation and retirement preserve inserted history", async (t) => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client'; import {DocumentTextViewer} from './src/ui/deal-document-text-viewer'; window.mountViewer=(host,source,client)=>{ const root=createRoot(host); root.render(<DocumentTextViewer source={source} client={client} quoteClient={client} onClose={()=>root.unmount()}/>); };`,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    bundle: true,
    jsx: "automatic",
    format: "esm",
    write: false,
  });
  const output = bundle.outputFiles[0];
  assert.ok(output);
  await page.route("**/quote-lifecycle.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: output.text }),
  );
  await page.goto(`${server.origin}/conversations`);
  await page.addScriptTag({ type: "module", url: `${server.origin}/quote-lifecycle.js` });
  await page.waitForFunction(() => typeof window.mountViewer === "function");
  const fixtures = Object.fromEntries(
    await Promise.all(
      ["full", "split", "continuation"].map(async (name) => [
        name,
        JSON.parse(await readFile(new URL(`./fixtures/deal-document-text/${name}.json`, import.meta.url), "utf8")),
      ]),
    ),
  );
  await page.evaluate(async (fixtures) => {
    const fixturePath = "/js/fixture-client.js";
    const { createFixtureClient } = await import(fixturePath);
    const client: QuoteTestClient = await createFixtureClient();
    window.pendingText = [];
    window.pendingConversations = [];
    const read = client.readDocConversation.bind(client);
    client.readDocConversation = async (args, options) => {
      const value = await read(args, options);
      return window.holdConversation
        ? new Promise((resolve) => window.pendingConversations.push(() => resolve(value)))
        : value;
    };
    client.readDealDocumentText = () => new Promise((resolve) => window.pendingText.push(resolve));
    const host = document.createElement("section");
    host.id = "quote-test";
    document.querySelector("main")?.replaceChildren(host);
    window.openViewer = () =>
      window.mountViewer(
        host,
        {
          deal_id: fixtures.full.deal_id,
          attachment_id: fixtures.full.attachment_id,
          content_hash: fixtures.full.content_hash,
          filename: "Synthetic lease.pdf",
        },
        client,
      );
    window.openViewer();
  }, fixtures);
  const host = page.locator("#quote-test");
  const resolveText = async (value: unknown) => {
    await page.waitForFunction(() => window.pendingText.length > 0);
    await page.evaluate((value) => window.pendingText.shift()?.(value), value);
  };
  const choose = async () => {
    await host.getByRole("button", { name: "Choose conversation", exact: true }).click();
    const picker = host.getByRole("combobox", { name: "Conversation for next ask" });
    await picker.waitFor();
    const id = await picker.locator("option").nth(1).getAttribute("value");
    assert.ok(id);
    await picker.selectOption(id);
    return { picker, id };
  };
  await resolveText(fixtures.full);
  await host.getByRole("button", { name: "Select line 1", exact: true }).first().click();
  await host.getByRole("textbox", { name: "Comment on excerpt" }).fill("Uninserted comment");
  await host.getByRole("spinbutton", { name: "Page", exact: true }).fill("2");
  await host.getByRole("button", { name: "Read page", exact: true }).click();
  await resolveText(fixtures.split);
  assert.equal(await host.getByRole("button", { name: "Select line 1", exact: true }).isDisabled(), true);
  assert.equal(await host.getByRole("textbox", { name: "Comment on excerpt" }).count(), 0);
  await host.getByRole("button", { name: "Read next chunk", exact: true }).click();
  await resolveText(fixtures.continuation);
  await host.getByRole("button", { name: "Select line 1", exact: true }).click();
  await host.getByRole("textbox", { name: "Comment on excerpt" }).fill("Frozen comment");
  const { id } = await choose();
  const input = host.getByRole("textbox", { name: "Ask Dr. CRE", exact: true });
  await input.waitFor();
  await input.fill("Existing ask");
  const preview = await host.getByLabel("Excerpt preview").textContent();
  assert.ok(preview);
  assert.ok(preview.includes("😀second"));
  await host.getByRole("button", { name: "Use in next ask", exact: true }).click();
  await page.waitForFunction(
    (expected) => document.querySelector<HTMLTextAreaElement>("#quote-test #askText")?.value === expected,
    `Existing ask\n\n${preview}`,
  );
  assert.equal(await input.inputValue(), `Existing ask\n\n${preview}`);
  await host.getByRole("spinbutton", { name: "Page", exact: true }).fill("1");
  await host.getByRole("button", { name: "Read page", exact: true }).click();
  await resolveText({ ok: false, error: "source_changed" });
  await host.getByText("The original document changed.", { exact: false }).waitFor();
  assert.equal(await host.getByRole("textbox", { name: "Comment on excerpt" }).count(), 0);
  await host.getByRole("button", { name: "Close document text", exact: true }).click();
  await page.evaluate(() => window.openViewer());
  await resolveText(fixtures.full);
  await page.evaluate(() => {
    window.holdConversation = true;
  });
  const { picker } = await choose();
  await page.waitForFunction(() => window.pendingConversations.length === 1);
  await picker.selectOption("");
  await page.evaluate(() => window.pendingConversations.shift()?.());
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  assert.equal(await input.count(), 0);
  await picker.selectOption(id);
  await page.waitForFunction(() => window.pendingConversations.length === 1);
  await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
  await page.evaluate(() => window.pendingConversations.shift()?.());
  await host.getByText("Session expired. Sign in again to view document text.", { exact: false }).waitFor();
  assert.equal(await input.count(), 0);
  assert.equal(await host.locator("[data-text-line]").count(), 0);
  await page.goto(`${server.origin}/conversations?id=${id}`);
  const restored = page.getByRole("textbox", { name: "Ask Dr. CRE", exact: true });
  await restored.waitFor();
  assert.equal(await restored.inputValue(), `Existing ask\n\n${preview}`);
});

test("two browser tabs serialize autosave before a waiting quote insertion", async (t) => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const a = await browser.newPage();
  const context = a.context();
  const bundle = await build({
    stdin: {
      contents: `import {createAskOutbox} from './src/ui/queued-asks'; export const box=createAskOutbox({storage:localStorage,actor:'two-tabs',conversation:'00000000-0000-4000-8000-000000000001',online:()=>false,uuid:()=>crypto.randomUUID(),submit:async()=>({})});`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    write: false,
  });
  const output = bundle.outputFiles[0];
  assert.ok(output);
  await context.route("**/outbox-race.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: output.text }),
  );
  const b = await context.newPage();
  await a.goto(`${server.origin}/conversations`);
  await b.goto(`${server.origin}/conversations`);
  await a.evaluate(async () => {
    const path = "/outbox-race.js";
    const { box } = await import(path);
    await box.saveDraft("original");
  });
  await b.evaluate(async () => {
    const path = "/outbox-race.js";
    const { box } = await import(path);
    void navigator.locks.request("doctorcre:asks:v1:two-tabs:00000000-0000-4000-8000-000000000001:draft", async () => {
      document.body.dataset.lock = "held";
      await new Promise<void>((resolve) => window.addEventListener("release-draft", () => resolve(), { once: true }));
    });
    void box.saveDraft("other tab draft").then(() => {
      document.body.dataset.saved = "yes";
    });
  });
  await b.waitForFunction(() => document.body.dataset.lock === "held");
  await a.evaluate(async () => {
    const path = "/outbox-race.js";
    const { box } = await import(path);
    void box.appendDraft("quote", "original").then(
      () => {
        document.body.dataset.insertion = "success";
      },
      (error: Error) => {
        document.body.dataset.insertion = error.message;
      },
    );
  });
  assert.equal(await a.evaluate(() => document.body.dataset.insertion), undefined);
  await b.evaluate(() => window.dispatchEvent(new Event("release-draft")));
  await b.waitForFunction(() => document.body.dataset.saved === "yes");
  await a.waitForFunction(() => document.body.dataset.insertion?.includes("another tab"));
  assert.equal(
    await a.evaluate(async () => {
      const path = "/outbox-race.js";
      return (await import(path)).box.draft();
    }),
    "other tab draft",
  );
});
