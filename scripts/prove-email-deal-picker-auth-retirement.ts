import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parse } from "es-module-lexer";
import type { Browser, Page } from "playwright";
import { proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";
import { chromium } from "./proof-browser.mjs";

export async function exercise(page: Page, asset: string) {
  return page.evaluate(async (asset) => {
    const { mountEmailActions, actionModel } = await import(asset);
    const assertions: string[] = [];
    const check = (value: unknown, label: string) => {
      if (!value) throw Error(label);
      assertions.push(label);
    };
    const tick = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const row = {
      id: "synthetic-proposal",
      version: 1,
      kind: "file_to_deal",
      deal: "d1",
      source: { activity_id: "synthetic-activity", evidence_quote: "Synthetic evidence" },
    };
    const board = {
      deals: [
        { id: "d1", name: "Synthetic One" },
        { id: "d2", name: "Synthetic Two" },
      ],
    };
    const exact = (args: { deal: string }) => ({
      contract: "email-followups.v2",
      proposal_id: row.id,
      deal: args.deal,
      base_version: 1,
      activity_id: row.source.activity_id,
      evidence_quote: row.source.evidence_quote,
      requires_confirmation: true,
      proposal_digest: `sha256:${"a".repeat(64)}`,
    });
    function mount(overrides = {}) {
      const host = document.createElement("section");
      document.body.append(host);
      const counts = { denied: 0, preview: 0, create: 0, confirm: 0 };
      const model = actionModel();
      const listeners: Record<string, EventListener> = {};
      const add = host.addEventListener.bind(host);
      host.addEventListener = (
        type: string,
        fn: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (typeof fn === "function") listeners[type] = fn;
        if (fn) add(type, fn, options);
      };
      const client = {
        getBoard: async () => board,
        previewEmailFiling: async (args: { deal: string }) => {
          counts.preview++;
          return exact(args);
        },
        createDeal: async () => {
          counts.create++;
          return { deal_id: "created" };
        },
        confirmEmailFiling: async (args: { note: string; deal: string }) => {
          counts.confirm++;
          return {
            ok: true,
            proposal_id: row.id,
            status: "confirmed",
            disposition: "filed",
            version: 2,
            note: args.note,
            deal: args.deal,
            activity_id: row.source.activity_id,
          };
        },
        ...overrides,
      };
      const view = mountEmailActions(
        host,
        row,
        client,
        model,
        () => {},
        () => {
          check(!host.querySelector("form,input,select,textarea,button,a"), "private controls removed before denial");
          counts.denied++;
        },
      );
      const click = (action: string) => {
        const node = host.querySelector<HTMLButtonElement>(`[data-followup="${action}"]`);
        if (!node) throw Error(`Missing ${action}`);
        node.click();
      };
      const submit = () => {
        const form = host.querySelector("form");
        if (!form) throw Error("Missing form");
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      };
      const fill = (key: string, value: string) => {
        const node = host.querySelector<HTMLInputElement>(`[data-field="${key}"]`);
        if (!node) throw Error(`Missing ${key}`);
        node.value = value;
        node.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const stale = () => {
        const oldState = model.state;
        const target = document.createElement("button");
        target.dataset.followup = "confirm";
        const click = new Event("click");
        Object.defineProperty(click, "target", { value: target });
        listeners.click?.(click);
        listeners.submit?.(new Event("submit", { cancelable: true }));
        view.update(row, true);
        check(
          model.state === oldState && !host.querySelector("button,form"),
          "retained handlers and update cannot revive editor",
        );
      };
      const close = () => {
        view.dispose();
        host.remove();
      };
      return { host, counts, model, view, click, fill, submit, stale, close };
    }
    for (const error of [{ status: 401 }, { status: 403 }, { code: "session_changed" }]) {
      const m = mount({
        getBoard: async () => {
          throw error;
        },
      });
      m.click("file");
      await tick();
      check(m.counts.denied === 1, `board denial ${JSON.stringify(error)}`);
      m.stale();
      check(m.counts.preview + m.counts.create + m.counts.confirm === 0, "retired editor makes no calls");
      m.close();
    }
    for (const error of [{ status: 401 }, { status: 403 }, { code: "session_changed" }]) {
      for (const replacement of [false, true]) {
        let rejectBoard: (error: unknown) => void = () => {
          throw Error("Read not started");
        };
        const m = mount({
          getBoard: () =>
            new Promise((_resolve, reject) => {
              rejectBoard = reject;
            }),
        });
        m.click("file");
        m.click("cancel");
        check(m.model.state.kind === "idle", "pending deal editor cancels");
        if (replacement) {
          m.click("new");
          m.fill("name", "Synthetic");
          m.fill("client", "Synthetic");
        }
        const form = m.host.querySelector("form");
        rejectBoard(error);
        await tick();
        check(
          m.counts.denied === 1 && !m.host.querySelector("form,button,input,select,textarea,a"),
          `canceled board denial retires ${replacement ? "replacement" : "ready"} ${JSON.stringify(error)}`,
        );
        form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        m.stale();
        await tick();
        check(m.counts.preview + m.counts.create + m.counts.confirm === 0, "canceled board denial prevents new calls");
        m.close();
      }
    }
    {
      const m = mount({
        getBoard: async () => {
          throw Error("network");
        },
      });
      m.click("file");
      await tick();
      check(
        m.counts.denied === 0 && m.host.textContent.includes("Could not load deals"),
        "network failure remains recoverable",
      );
      m.click("cancel");
      m.click("new");
      m.fill("name", "Synthetic new");
      m.fill("client", "Synthetic client");
      m.submit();
      await tick();
      check(m.model.state.kind === "preview", "network cancel returns ready and new creation previews");
      m.click("cancel");
      check(m.model.state.kind === "created", "created deal survives cancelled filing");
      m.click("preview-created");
      await tick();
      m.click("confirm");
      await tick();
      check(
        m.model.state.kind === "done" && m.counts.create === 1,
        "created recovery confirms without duplicate creation",
      );
      m.close();
    }
    for (const disposed of [false, true]) {
      let resolve: (board: unknown) => void = () => {
        throw Error("Read not started");
      };
      const m = mount({
        getBoard: () =>
          new Promise((done) => {
            resolve = done;
          }),
        previewEmailFiling: async () => {
          throw { status: 401 };
        },
      });
      m.click("file");
      if (disposed) m.view.dispose();
      else {
        m.submit();
        await tick();
        check(m.counts.denied === 1, "preview denial retires");
      }
      resolve(board);
      await tick();
      m.stale();
      check(
        !m.host.textContent.includes("Synthetic One"),
        disposed ? "disposed ignores late board" : "retired ignores late board",
      );
      if (!disposed) m.close();
      else m.host.remove();
    }
    {
      const writes: { note: string; deal: string }[] = [];
      const m = mount({
        confirmEmailFiling: async (args: { note: string; deal: string }) => {
          writes.push(args);
          if (writes.length === 1) throw Error("lost");
          return {
            ok: true,
            proposal_id: row.id,
            status: "confirmed",
            disposition: "filed",
            version: 2,
            note: args.note,
            deal: args.deal,
            activity_id: row.source.activity_id,
          };
        },
      });
      m.click("file");
      await tick();
      const search = m.host.querySelector<HTMLInputElement>("[data-deal-search]");
      if (!search) throw Error("Missing search");
      search.value = "Two";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      check(m.host.querySelector("option[value=d2]")?.textContent === "Synthetic Two", "successful deal search");
      m.fill("deal", "d2");
      m.submit();
      await tick();
      const { request: previewRequest } = m.model.state;
      check(m.model.state.kind === "preview" && previewRequest.deal === "d2", "exact target preview");
      m.click("confirm");
      await tick();
      check(m.model.state.kind === "unknown", "unknown write retains recovery");
      m.click("replay");
      await tick();
      check(
        m.model.state.kind === "done" && JSON.stringify(writes[0]) === JSON.stringify(writes[1]),
        "pending recovery replays identical request",
      );
      m.close();
    }
    for (const stage of ["create", "created-preview", "confirm"]) {
      const error = { code: "session_changed" };
      const m = mount(
        stage === "create"
          ? {
              createDeal: async () => {
                throw error;
              },
            }
          : stage === "created-preview"
            ? {
                previewEmailFiling: async () => {
                  throw error;
                },
              }
            : {
                confirmEmailFiling: async () => {
                  throw error;
                },
              },
      );
      if (stage !== "confirm") {
        m.click("new");
        m.fill("name", "Synthetic");
        m.fill("client", "Synthetic");
      } else {
        m.click("file");
        await tick();
      }
      m.submit();
      await tick();
      if (stage === "confirm") {
        m.click("confirm");
        await tick();
      }
      check(m.counts.denied === 1, `${stage} denial retires`);
      m.stale();
      m.close();
    }
    {
      const m = mount({
        previewEmailFiling: async () => {
          throw Error("offline");
        },
      });
      m.click("file");
      await tick();
      m.submit();
      await tick();
      check(
        m.model.state.kind === "refused" && m.counts.denied === 0,
        "ordinary preview failure requires fresh review",
      );
      m.click("refresh");
      check(m.model.state.kind === "idle", "refresh returns ready");
      m.click("file");
      await tick();
      m.click("cancel");
      check(m.model.state.kind === "idle", "successful deal editor cancels");
      m.close();
    }
    {
      const requests: unknown[] = [];
      const m = mount({
        createDeal: async (request: unknown) => {
          requests.push(request);
          if (requests.length === 1) throw Error("lost");
          return { deal_id: "created" };
        },
        previewEmailFiling: async () => {
          throw Error("offline");
        },
      });
      m.click("new");
      m.fill("name", "Synthetic");
      m.fill("client", "Synthetic");
      m.submit();
      await tick();
      check(m.model.state.kind === "creation-unknown", "uncertain creation keeps request");
      m.click("replay");
      await tick();
      check(
        m.model.state.kind === "created" && JSON.stringify(requests[0]) === JSON.stringify(requests[1]),
        "creation replay and failed preview retain created deal",
      );
      m.close();
    }
    return assertions;
  }, asset);
}

class Unavailable extends Error {}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function prove({ origin, commit, timeoutMs = 30000 }: { origin: string; commit: string; timeoutMs?: number }) {
  const base = new URL(origin);
  if (!["http:", "https:"].includes(base.protocol) || base.origin !== origin || base.username || base.password)
    throw Error("Expected a bare HTTP origin");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error("timeout-ms must be 1..30000");
  assert.match(commit, /^[a-f0-9]{40}$/);
  const controller = new AbortController(),
    assets = new Map<string, Buffer>();
  const deadline = Date.now() + timeoutMs;
  let requests = 0,
    browserPromise: Promise<Browser> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    routeFailure: Error | undefined;
  const read = async (url: URL) => {
    if (url.origin !== origin || ++requests > 10) throw Error("Request budget or origin violation");
    let response: Response;
    try {
      response = await proofFetch(url, { redirect: "manual", signal: controller.signal });
    } catch {
      throw new Unavailable("Release or asset evidence unavailable");
    }
    if (!response.ok) throw new Unavailable(`Evidence HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    if (!response.body) throw new Unavailable("Missing evidence body");
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) throw Error("Evidence byte limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const work = async () => {
    const release = await readAppRelease(origin, async (url) => ({ type: "application/json", body: await read(url) }));
    await requireContainingRelease(commit, release.source_commit, { signal: controller.signal });
    const manifest = JSON.parse((await read(new URL("/artifact-manifest.json", base))).toString());
    assert.equal(manifest.schema, "doctorcre-static-artifact.v1", "Manifest schema");
    assert.equal(manifest.source_commit, release.source_commit, "Manifest release identity");
    assert.ok(Array.isArray(manifest.files), "Manifest files");
    const entries = new Map();
    for (const file of manifest.files) {
      assert.ok(typeof file.path === "string" && !entries.has(file.path), "Unique manifest path");
      entries.set(file.path, file);
    }
    const load = async (path: string) => {
      if (assets.has(path)) return;
      assert.match(path, /^js\/[A-Za-z0-9_.-]+\.js$/, "Admitted module path");
      const entry = entries.get(path);
      assert.ok(entry, "Module in manifest");
      const bytes = await read(new URL(`/${path}`, base));
      assert.equal(bytes.length, entry.bytes, "Asset length");
      assert.equal(hash(bytes), entry.sha256, "Asset hash");
      assets.set(path, bytes);
      const [imports] = await parse(bytes.toString());
      for (const item of imports) {
        assert.ok(item.n, "Named module dependency required");
        assert.ok(item.n.startsWith("./"), "Only static relative module dependencies");
        const dependency = new URL(item.n, new URL(`/${path}`, base));
        assert.equal(dependency.origin, origin);
        assert.equal(dependency.search + dependency.hash, "");
        await load(dependency.pathname.slice(1));
      }
    };
    await load("js/ui-email-actions.generated.js");
    if (controller.signal.aborted || Date.now() >= deadline) throw new Unavailable("Proof timeout");
    browserPromise = chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS], timeout: Math.max(1, deadline - Date.now()) });
    const browser = await browserPromise;
    const page = await browser.newPage({ serviceWorkers: "block" });
    const context = page.context();
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin && route.request().method() === "GET" && url.pathname === "/__email-proof__")
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
      const bytes =
        url.origin === origin &&
        !url.search &&
        !url.hash &&
        route.request().method() === "GET" &&
        assets.get(url.pathname.slice(1));
      if (bytes) return route.fulfill({ contentType: "text/javascript", body: bytes });
      routeFailure = Error("Unexpected browser request");
      await route.abort();
    });
    await page.goto(`${origin}/__email-proof__`);
    const assertions = await exercise(page, `${origin}/js/ui-email-actions.generated.js`);
    if (routeFailure) throw routeFailure;
    return {
      release,
      assets: [...assets].map(([path, bytes]) => ({ path, sha256: hash(bytes) })),
      assertions,
      requests,
      synthetic: true,
    };
  };
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Unavailable("Proof timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await (await browserPromise?.catch(() => null))?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 6 ||
      args[0] !== "--origin" ||
      args[2] !== "--commit" ||
      args[4] !== "--timeout-ms" ||
      !args[1] ||
      !args[3]
    )
      throw Error("Usage: --origin <origin> --commit <merge-commit> --timeout-ms <milliseconds>");
    console.log(JSON.stringify(await prove({ origin: args[1], commit: args[3], timeoutMs: Number(args[5]) })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode =
      error instanceof Unavailable
        ? 78
        : error && typeof error === "object" && "exitCode" in error && typeof error.exitCode === "number"
          ? error.exitCode
          : 1;
  }
}
