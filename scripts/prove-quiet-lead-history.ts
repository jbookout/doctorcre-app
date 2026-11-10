import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, BrowserType, Page } from "playwright";
import { chromium as cdpChromium } from "playwright";
import type { QuietProposal } from "../js/leads-client.d.ts";
import { launchProofBrowser, readAppRelease } from "./app-release-reader.mjs";
import { chromium } from "./proof-browser.mjs";

type ProofOptions = {
  origin?: string | undefined;
  expectedCommit?: string | undefined;
  fixture?: boolean | undefined;
  timeoutMs?: number | undefined;
  cdpUrl?: string | undefined;
  engine?: { launch?: BrowserType["launch"]; connectOverCDP?: BrowserType["connectOverCDP"] };
  readRelease?: (origin: URL, options: { timeoutMs: number }) => Promise<{ source_commit: string }>;
  ancestry?: (expected: string, source: string) => Promise<boolean>;
  recordingUrl?: string | URL | undefined;
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const unavailable = (message: string) => Object.assign(Error(message), { exitCode: 78 });
export async function prove({
  origin = "http://localhost",
  expectedCommit = "",
  fixture = false,
  timeoutMs = 30000,
  cdpUrl,
  engine = chromium,
  readRelease = readAppRelease,
  ancestry,
  recordingUrl = new URL("../test/fixtures/quiet-lead-owner-pages/recordings.json", import.meta.url),
}: ProofOptions = {}) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit || "") || /^0+$/.test(expectedCommit))
    throw unavailable("Expected merge commit required");
  let base = new URL(origin);
  const releaseBase = base;
  assert.ok(
    base.href === `${base.origin}/` && !base.username && !base.password && ["https:", "http:"].includes(base.protocol),
    "origin only",
  );
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000, "bounded deadline");
  const controller = new AbortController(),
    deadline = Date.now() + timeoutMs;
  let expire: () => void = () => {};
  const expired = new Promise<never>((_, reject) => {
    expire = () => {
      const error = unavailable("Proof deadline exceeded");
      controller.abort(error);
      reject(error);
    };
  });
  void expired.catch(() => {});
  const timer = setTimeout(expire, timeoutMs);
  function bounded<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, expired]);
  }
  const remaining = () => Math.max(1, deadline - Date.now());
  let browser: Browser | undefined, page: Page | undefined, pendingBrowser: Promise<Browser> | undefined;
  const pendingPages: Promise<Page>[] = [];
  let fixtureServer: { origin: string; close(): Promise<void> } | undefined;
  const release = async () => bounded(readRelease(releaseBase, { timeoutMs: remaining() }));
  async function contains(source: string) {
    if (!/^[a-f0-9]{40}$/.test(source || "") || /^0+$/.test(source)) throw unavailable("Unknown release");
    if (source === expectedCommit) return;
    try {
      if (ancestry) {
        if (!(await bounded(ancestry(expectedCommit, source))))
          throw unavailable("Release does not contain expected merge");
      } else
        await bounded(
          new Promise<void>((resolveResult, reject) => {
            execFile(
              "git",
              ["merge-base", "--is-ancestor", expectedCommit, source],
              { signal: controller.signal, timeout: remaining() },
              (error) => (error ? reject(error) : resolveResult()),
            );
          }),
        );
    } catch {
      throw unavailable("Release ancestry evidence unavailable or release does not contain expected merge");
    }
  }
  try {
    const before = await release();
    await contains(before.source_commit);
    if (!fixture && !cdpUrl) throw unavailable("Existing signed-in browser session required");
    if (fixture && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
      throw unavailable("Fixture requires loopback");
    const recording = fixture ? JSON.parse(await readFile(recordingUrl, "utf8")) : null;
    const fixtureRegistry = fixture
      ? JSON.parse(await readFile(new URL("../test/fixtures/walk-verb-registry.json", import.meta.url), "utf8"))
          .response
      : null;
    try {
      if (fixture)
        browser = await launchProofBrowser(
          engine.launch ? { launch: engine.launch.bind(engine) } : chromium,
          { timeout: remaining() },
          { signal: controller.signal },
        );
      else {
        pendingBrowser = Promise.resolve()
          .then(() =>
            (engine.connectOverCDP?.bind(engine) ?? cdpChromium.connectOverCDP.bind(cdpChromium))(cdpUrl ?? "", {
              timeout: remaining(),
            }),
          )
          .then(async (acquired) => {
            if (controller.signal.aborted) {
              await acquired.close();
              throw controller.signal.reason;
            }
            return acquired;
          });
        browser = await bounded(pendingBrowser);
      }
      if (!fixture && !browser.contexts()[0]) throw unavailable("Signed-in context unavailable");
      const context = browser.contexts()[0];
      if (!fixture && !context) throw unavailable("Signed-in context unavailable");
      const acquisition = (
        fixture
          ? browser.newPage({ viewport: { width: 390, height: 844 } })
          : context
            ? context.newPage()
            : Promise.reject(unavailable("Signed-in context unavailable"))
      ).then(async (acquired) => {
        if (controller.signal.aborted) {
          await acquired.close();
          throw controller.signal.reason;
        }
        return acquired;
      });
      pendingPages.push(acquisition);
      page = await bounded(acquisition);
    } catch (error) {
      throw unavailable(`Browser session unavailable: ${messageOf(error)}`);
    }
    if (fixture) {
      const { historyFixture } = await import("../test/quiet-lead-history-fixture.ts");
      fixtureServer = await historyFixture(recording, fixtureRegistry, controller.signal);
      base = new URL(fixtureServer.origin);
    }
    let rpc = 0,
      writes = 0,
      blocked = 0;
    const observedVerbs: string[] = [];
    let verbWrites: Map<string, boolean> | undefined;
    let admit: () => void = () => {};
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    await bounded(
      page.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (["GET", "HEAD"].includes(request.method())) return route.fallback();
        if (url.origin !== base.origin || url.pathname !== "/mcp") {
          blocked++;
          return route.abort();
        }
        const name = request.postDataJSON()?.params?.name;
        rpc++;
        observedVerbs.push(name);
        if (name !== "list-verbs") {
          try {
            await bounded(admitted);
          } catch {
            return route.abort().catch(() => {});
          }
        }
        if (name !== "list-verbs" && (!verbWrites?.has(name) || verbWrites.get(name))) {
          blocked++;
          return route.abort();
        }
        return route.fallback();
      }),
    );
    const activePage = page;
    const read = async (name: string) =>
      bounded(
        activePage.evaluate(
          async ({ name, timeoutMs }) => {
            const { createMcpRequests } = await import(String("/js/mcp-requests.mjs"));
            return createMcpRequests()(name, name === "list-verbs" ? { names_only: true } : {}, { timeoutMs });
          },
          { name, timeoutMs: remaining() },
        ),
      );
    await bounded(page.goto(new URL("/leads", base).href, { timeout: remaining(), waitUntil: "commit" }));
    let registry: unknown;
    try {
      const outcome = await read("list-verbs");
      registry = outcome.payload;
      if (
        outcome.kind !== "payload" ||
        outcome.isError ||
        typeof registry !== "object" ||
        registry === null ||
        !("ok" in registry) ||
        registry.ok !== true ||
        !("verbs" in registry) ||
        !("count" in registry) ||
        !Array.isArray(registry.verbs) ||
        !registry.verbs.length ||
        registry.count !== registry.verbs.length ||
        !registry.verbs.every(
          (verb: unknown): verb is { name: string; write: boolean } =>
            typeof verb === "object" &&
            verb !== null &&
            "name" in verb &&
            typeof verb.name === "string" &&
            "write" in verb &&
            typeof verb.write === "boolean",
        ) ||
        new Set(registry.verbs.map((verb: { name: string; write: boolean }) => verb.name)).size !==
          registry.verbs.length
      )
        throw Error("Registry refused");
      verbWrites = new Map(registry.verbs.map((verb: { name: string; write: boolean }) => [verb.name, verb.write]));
      if (verbWrites.get("list-verbs") !== false) throw Error("Registry read classification unavailable");
    } catch (error) {
      throw unavailable(`Verb registry unavailable: ${messageOf(error)}`);
    } finally {
      admit();
    }
    const outcome = await read("quiet-follow-ups");
    if (outcome.kind !== "payload" || outcome.isError) throw unavailable("Quiet snapshot unavailable");
    let leads: QuietProposal[];
    try {
      leads = await bounded(
        page.evaluate(async (snapshot) => {
          const { validateQuietFollowUps } = await import(String("/js/leads-client.js"));
          return validateQuietFollowUps(snapshot).proposals.filter((row: QuietProposal) => row.subject_type === "lead");
        }, outcome.payload),
      );
    } catch {
      throw unavailable("Quiet snapshot invalid");
    }
    if (
      !leads.some((row) => row.basis === "created_at") ||
      !leads.some((row) => row.basis === "last_contact") ||
      !["created_at", "last_contact"].some((basis) => leads.filter((row) => row.basis === basis).length > 10)
    )
      throw unavailable("Insufficient natural history and paging subjects");
    const section = page.locator("#quietFollowUps");
    const date = (value: string) =>
      new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
        timeZone: "America/Chicago",
        month: "short",
        day: "numeric",
      });
    async function checkPage(rows: QuietProposal[], offset: number) {
      const visible = rows.slice(offset, offset + 10);
      const expected = visible.map((row) => ({
        id: row.subject_id,
        name: row.name,
        href: `/leads?lead=${encodeURIComponent(row.ref)}`,
        reason:
          (row.basis === "created_at"
            ? `No contact recorded. Added ${date(row.anchor_on)}.`
            : `Last contact ${date(row.anchor_on)}.`) +
          ` Follow-up due ${date(row.due_on)}` +
          (row.days_overdue > 0 ? ` · ${row.days_overdue} ${row.days_overdue === 1 ? "day" : "days"} overdue` : ""),
      }));
      assert.deepEqual(
        await bounded(
          section.locator("a[data-quiet-lead]").evaluateAll((nodes) =>
            nodes.map((node) => ({
              id: node.dataset.quietLead,
              name: node.querySelector("span")?.textContent,
              href: node.getAttribute("href"),
              reason: node.querySelector("p")?.textContent,
            })),
          ),
        ),
        expected,
      );
      assert.equal(
        await bounded(section.getByRole("status").textContent()),
        rows.length
          ? `Showing ${offset + 1}–${Math.min(offset + 10, rows.length)} of ${rows.length} matching loaded leads (${leads.length} loaded).`
          : `0 matching loaded leads (${leads.length} loaded).`,
      );
      if (!rows.length) return;
      assert.equal(
        await bounded(
          section.getByRole("button", { name: "Previous leads", exact: true }).getAttribute("aria-disabled"),
        ),
        String(offset === 0),
      );
      assert.equal(
        await bounded(section.getByRole("button", { name: "Next leads", exact: true }).getAttribute("aria-disabled")),
        String(offset + 10 >= rows.length),
      );
    }
    const history = section.getByRole("combobox", { name: "Contact history", exact: true });
    const owner = section.getByRole("combobox", { name: "Quiet lead owner", exact: true });
    const input = section.getByRole("searchbox");
    await bounded(history.waitFor({ timeout: remaining() }));
    await bounded(page.waitForLoadState("networkidle", { timeout: remaining() }));
    const beforeLocal = rpc;
    assert.deepEqual(
      await bounded(
        history.locator("option").evaluateAll((nodes) => nodes.map((n) => [n.getAttribute("value"), n.textContent])),
      ),
      [
        ["all", "All contact history"],
        ["created_at", "No contact recorded"],
        ["last_contact", "Contact recorded"],
      ],
    );
    for (const basis of ["created_at", "last_contact", "all"]) {
      await bounded(history.selectOption(basis));
      const rows = leads.filter((row) => basis === "all" || row.basis === basis);
      for (let offset = 0; offset < rows.length; offset += 10) {
        assert.ok(offset < 1000, "bounded loaded list");
        await checkPage(rows, offset);
        if (offset + 10 < rows.length)
          await bounded(section.getByRole("button", { name: "Next leads", exact: true }).click());
      }
    }
    const subject = leads[0];
    assert.ok(subject, "eligible lead");
    const basis = subject.basis;
    const key = subject.owner == null ? "unrecorded" : `owner:${subject.owner}`;
    const query = subject.ref.trim().toLowerCase();
    await bounded(history.selectOption(basis));
    await bounded(owner.selectOption(key));
    await bounded(input.fill(query));
    await checkPage(
      leads.filter(
        (row) =>
          row.basis === basis &&
          (row.owner ?? null) === (subject.owner ?? null) &&
          (row.name.toLowerCase().includes(query) || row.ref.toLowerCase().includes(query)),
      ),
      0,
    );
    await bounded(section.getByRole("button", { name: "Clear search", exact: true }).click());
    assert.equal(await bounded(input.inputValue()), "");
    assert.equal(await bounded(history.inputValue()), basis);
    assert.equal(await bounded(owner.inputValue()), key);
    await checkPage(
      leads.filter((row) => row.basis === basis && (row.owner ?? null) === (subject.owner ?? null)),
      0,
    );
    assert.equal(rpc, beforeLocal, "history, owner, search and pages make no calls");
    for (const name of observedVerbs) {
      assert.ok(verbWrites?.has(name), "observed verb classified");
      if (verbWrites?.get(name)) writes++;
    }
    assert.equal(blocked, 0, "no attempted writes or unknown calls");
    assert.equal(writes, 0, "zero business writes");
    const after = await release();
    await contains(after.source_commit);
    if (JSON.stringify(after) !== JSON.stringify(before)) throw unavailable("Release changed during observation");
    return {
      ok: true,
      mode: fixture ? "local-fixture" : "natural",
      release: before,
      leads: leads.length,
      writes,
      filter_reads: rpc - beforeLocal,
    };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    await fixtureServer?.close().catch(() => {});
    await page?.close().catch(() => {});
    await Promise.allSettled(pendingPages.map((pending) => pending.then((acquired) => acquired.close())));
    await browser?.close().catch(() => {});
    if (!browser && pendingBrowser) await pendingBrowser.then((acquired) => acquired.close()).catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        origin: { type: "string" },
        "expected-commit": { type: "string" },
        "cdp-url": { type: "string" },
        "timeout-ms": { type: "string" },
        recording: { type: "string" },
        fixture: { type: "boolean", default: false },
      },
    });
    const result = await prove({
      origin: values.origin,
      expectedCommit: values["expected-commit"],
      fixture: values.fixture,
      cdpUrl: values["cdp-url"],
      timeoutMs: Number(values["timeout-ms"] || 30000),
      recordingUrl: values.recording,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        error: messageOf(error),
        status:
          error instanceof Error && "exitCode" in error && error.exitCode === 78
            ? "insufficient_evidence"
            : "assertion_failure",
      }),
    );
    process.exitCode =
      error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
  }
}
