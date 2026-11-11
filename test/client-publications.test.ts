import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type { Publication, Request } from "../src/ui/client-publication-contract.ts";
import { envelope, parsePublications } from "../src/ui/client-publication-contract.ts";

const built = await build({
  entryPoints: ["src/ui/client-publications.tsx"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const bundle = Buffer.from(built.outputFiles?.[0]?.contents ?? []);
const ui: typeof import("../src/ui/client-publications.tsx") = await import(
  "data:text/javascript;base64," + bundle.toString("base64")
);
const dealId = "11111111-1111-4111-8111-111111111111";
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
function required(element: Element, selector: string) {
  const node = element.querySelector<HTMLInputElement>(selector);
  assert.ok(node);
  return node;
}
function open(request: Request) {
  const dom = new JSDOM('<div id="view"></div>');
  Reflect.set(globalThis, "window", dom.window);
  Reflect.set(globalThis, "document", dom.window.document);
  Reflect.set(globalThis, "FormData", dom.window.FormData);
  const element = document.querySelector<HTMLElement>("#view");
  assert.ok(element);
  const panel = ui.mountClientPublications(element, { dealId, request });
  return { element, panel, dom };
}
test("CLIENT-VIEW hides drafts until explicit publish and removes withdrawn content", async () => {
  const fake = ui.createPublicationFixture();
  const writes: Record<string, unknown>[] = [];
  const { element, panel } = open(async (...args) => {
    if (args[0] === "set-client-publication") writes.push({ ...args[1] });
    return fake(...args);
  });
  await settle();
  assert.equal(writes.length, 0);
  assert.doesNotMatch(required(element, "[data-client-preview]").textContent, /Site visit scheduled/);
  required(element, "[data-publish]").click();
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(writes.at(0)?.published, true);
  assert.match(required(element, "[data-client-preview]").textContent, /Site visit scheduled/);
  required(element, "[data-unpublish]").click();
  await settle();
  assert.doesNotMatch(required(element, "[data-client-preview]").textContent, /Site visit scheduled/);
  panel.dispose();
});
test("unknown write outcome retains same key and stops new writes until explicit retry", async () => {
  const fake = ui.createPublicationFixture();
  const writes: Record<string, unknown>[] = [];
  let fail = true;
  const { element, panel } = open(async (name, args, options) => {
    if (name === "set-client-publication") {
      writes.push({ ...args });
      const result = await fake(name, args, options);
      if (fail) {
        fail = false;
        throw Error("network");
      }
      return result;
    }
    return fake(name, args, options);
  });
  await settle();
  required(element, "[data-publish]").click();
  await settle();
  assert.match(element.textContent, /not confirmed/);
  assert.equal(element.querySelector("[data-publish]"), null);
  required(element, "[data-retry]").click();
  await settle();
  assert.deepEqual(writes[0], writes[1]);
  assert.match(required(element, "[data-client-preview]").textContent, /Site visit scheduled/);
  panel.dispose();
});
test("read failures hide preview, refresh retries, session invalidation fences late results", async () => {
  const fake = ui.createPublicationFixture();
  let fail = true;
  const { element, panel, dom } = open(async (...args) => {
    if (fail) throw Error("SQL private");
    return fake(...args);
  });
  await settle();
  assert.match(element.textContent, /Client view unavailable/);
  assert.doesNotMatch(element.textContent, /SQL private/);
  fail = false;
  await panel.refresh();
  assert.ok(element.querySelector("[data-client-preview]"));
  dom.window.dispatchEvent(new dom.window.Event("doctorcre-session-invalidated"));
  assert.equal(element.querySelector("[data-client-preview]"), null);
  panel.dispose();
});
test("preview uses the server projection only, never published flags, private fields or automatic phases", async () => {
  const fake = ui.createPublicationFixture();
  const { element, panel } = open(async (name, ...rest) => {
    if (name === "list-deal-deliverables") return fake(name, ...rest);
    const result = envelope(await fake(name, ...rest));
    if (name === "list-deal-client-publications")
      return {
        ...result,
        publications: parsePublications(result).map((p) => ({ ...p, published: true, content: "PRIVATE DRAFT" })),
      };
    if (name === "preview-deal-client-view")
      return {
        ...result,
        portal: {
          slug: "synthetic",
          internal_notes: "PRIVATE NOTE",
          roadmap: { current_phase: "INTERNAL PHASE" },
          materials: [{ kind: "document", title: "Shared brief", content: "Public text" }],
          publications: [
            {
              kind: "deliverable",
              title: "Final packet",
              deliverable: {
                id: dealId,
                filename: "packet.pdf",
                mime: "application/pdf",
                bytes: 500,
                object_key: "SECRET KEY",
              },
            },
          ],
        },
      };
    return result;
  });
  await settle();
  const preview = required(element, "[data-client-preview]").textContent;
  assert.match(preview, /Shared brief.*Public text.*packet.pdf/s);
  assert.doesNotMatch(preview, /PRIVATE|INTERNAL|SECRET|Site visit scheduled/);
  assert.equal(element.querySelector("[data-client-preview] button"), null);
  panel.dispose();
});
test("null portal disables publication, malformed or oversized responses fail closed", async () => {
  const fake = ui.createPublicationFixture();
  for (const portal of [
    null,
    {},
    {
      slug: "synthetic",
      materials: [],
      publications: Array(101).fill({ kind: "milestone", title: "Too many", content: "Text" }),
    },
  ]) {
    const { element, panel } = open(async (name, ...rest) =>
      name === "preview-deal-client-view"
        ? { ok: true, schema_version: "client-publications.v1", portal }
        : fake(name, ...rest),
    );
    await settle();
    if (portal === null) {
      assert.match(element.textContent, /No active client portal/);
      assert.equal(required(element, "[data-publish]").disabled, true);
    } else {
      assert.match(element.textContent, /Client view unavailable/);
      assert.equal(element.querySelector("[data-publish]"), null);
    }
    panel.dispose();
  }
});
test("session change during reads or a write hides all data and fences late completion", async () => {
  const fake = ui.createPublicationFixture();
  let resolve: () => void = () => {};
  let hold = false;
  const { element, panel, dom } = open(async (name, ...rest) => {
    const response = await fake(name, ...rest);
    if (hold)
      return new Promise((done) => {
        resolve = () => done(response);
      });
    return response;
  });
  await settle();
  hold = true;
  required(element, "[data-publish]").click();
  await settle();
  dom.window.dispatchEvent(new dom.window.Event("doctorcre-session-invalidated"));
  resolve();
  await settle();
  assert.match(element.textContent, /Session changed/);
  assert.equal(element.querySelector("[data-client-preview]"), null);
  panel.dispose();
  let finish: (value: unknown) => void = () => {};
  const late = open(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  late.panel.dispose();
  finish({});
  await settle();
  assert.equal(late.element.textContent, "");
});

test("saving a new draft never publishes and form edits cause no writes", async () => {
  const fake = ui.createPublicationFixture();
  const writes: Record<string, unknown>[] = [];
  const { element, panel, dom } = open(async (name, args, options) => {
    if (name === "set-client-publication") writes.push({ ...args });
    return fake(name, args, options);
  });
  await settle();
  required(element, "[name=title]").value = "New hidden milestone";
  required(element, "[name=content]").value = "Draft details";
  assert.equal(writes.length, 0);
  required(element, "form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(writes.at(0)?.published, false);
  assert.equal(writes.at(0)?.base_version, 0);
  assert.match(element.textContent, /New hidden milestone/);
  assert.doesNotMatch(required(element, "[data-client-preview]").textContent, /New hidden milestone|Draft details/);
  panel.dispose();
});

test("refreshed files publish their current exact version; withdrawal keeps the stored version", async () => {
  const fileId = "44444444-4444-4444-8444-444444444444";
  let version = 7,
    stored: Publication | null = null;
  const writes: Record<string, unknown>[] = [];
  const { element, panel } = open(async (name, args) => {
    if (name === "list-deal-deliverables")
      return {
        ok: true,
        schema_version: "deal-deliverables.v1",
        deliverables: [
          {
            id: fileId,
            deal_id: dealId,
            filename: "Final report.pdf",
            mime: "application/pdf",
            bytes: 500,
            sha256: "a".repeat(64),
            state: "finalized",
            visibility: "shared",
            version,
          },
        ],
      };
    if (name === "list-deal-client-publications")
      return { ok: true, schema_version: "client-publications.v1", publications: stored ? [stored] : [] };
    if (name === "preview-deal-client-view")
      return {
        ok: true,
        schema_version: "client-publications.v1",
        portal: { slug: "synthetic", materials: [], publications: [] },
      };
    writes.push({ ...args });
    assert.ok("publication_id" in args && "base_version" in args && typeof args.base_version === "number");
    stored =
      parsePublications({
        ok: true,
        schema_version: "client-publications.v1",
        publications: [{ ...args, id: args.publication_id, version: args.base_version + 1 }],
      })[0] ?? null;
    assert.ok(stored);
    return {
      ok: true,
      schema_version: "client-publications.v1",
      publication: { id: stored.id, version: stored.version, published: stored.published },
    };
  });
  await settle();
  required(element, "[data-publish-file]").click();
  await settle();
  assert.equal(writes.at(0)?.deliverable_version, 7);
  version = 8;
  await panel.refresh();
  required(element, "[data-unpublish]").click();
  await settle();
  assert.equal(writes.at(1)?.deliverable_version, 7);
  assert.equal(writes.at(1)?.base_version, 1);
  required(element, "[data-publish-file]").click();
  await settle();
  assert.equal(writes.at(2)?.deliverable_version, 8);
  assert.equal(writes.at(2)?.base_version, 2);
  panel.dispose();
});

test("authoritative refusal stops writes, shows a fixed hint, and refreshes versions", async () => {
  for (const error of [
    "publication_file_not_shared",
    "publication_version_conflict",
    "publication_denied",
    "publication_not_found",
  ]) {
    const fake = ui.createPublicationFixture();
    let refused = true;
    const { element, panel } = open(async (name, ...args) =>
      name === "set-client-publication" && refused ? { ok: false, error, message: "PRIVATE SQL" } : fake(name, ...args),
    );
    await settle();
    required(element, "[data-publish]").click();
    await settle();
    assert.ok(element.querySelector("[role=alert]"));
    assert.doesNotMatch(element.textContent, /PRIVATE SQL|not confirmed/);
    assert.equal(element.querySelector("[data-retry]"), null);
    refused = false;
    await panel.refresh();
    assert.ok(element.querySelector("[data-publish]"));
    panel.dispose();
  }
});

test("uncertain refresh reconciles and rejects mismatched receipt versions", async () => {
  const fake = ui.createPublicationFixture();
  const { element, panel } = open(async (name, ...args) => {
    if (name === "list-deal-deliverables") return fake(name, ...args);
    const result = envelope(await fake(name, ...args));
    return name === "set-client-publication"
      ? { ...result, publication: { id: "33333333-3333-4333-8333-333333333333", published: true, version: 99 } }
      : result;
  });
  await settle();
  required(element, "[data-publish]").click();
  await settle();
  assert.match(element.textContent, /not confirmed/);
  await panel.refresh();
  assert.ok(element.querySelector("[data-unpublish]"));
  panel.dispose();
});

test("every active state closes on session invalidation and fences pending work", async () => {
  for (const mode of ["loading", "ready", "saving", "uncertain", "unavailable", "refused"]) {
    const fake = ui.createPublicationFixture();
    let resolve: () => void = () => {};
    const { element, panel, dom } = open(async (name, ...args) => {
      if (mode === "loading" || (mode === "saving" && name === "set-client-publication"))
        return new Promise((done) => {
          resolve = () => done({});
        });
      if (mode === "unavailable") throw Error("offline");
      if (name === "set-client-publication" && mode === "uncertain") throw Error("offline");
      if (name === "set-client-publication" && mode === "refused")
        return { ok: false, error: "publication_file_not_shared" };
      return fake(name, ...args);
    });
    await settle();
    if (["saving", "uncertain", "refused"].includes(mode)) {
      required(element, "[data-publish]").click();
      await settle();
    }
    dom.window.dispatchEvent(new dom.window.Event("doctorcre-session-invalidated"));
    resolve();
    await settle();
    assert.match(element.textContent, /Session changed/);
    assert.equal(element.querySelector("[data-client-preview]"), null);
    panel.dispose();
  }
});
