import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Response as BrowserResponse, Page } from "playwright";
import type { Portal, Publication } from "../src/ui/client-publication-contract.ts";
import { parsePortal, parsePublications } from "../src/ui/client-publication-contract.ts";
import { launchProofBrowser, proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { requireContainingRelease, signedInEngine } from "./prove-terms-expense-basis.mjs";

const unavailable = (message: string) => Object.assign(Error(message), { exitCode: 78 });
type Evidence = {
  client_read: Record<string, unknown>;
  receipt: { id: string; version: number; published: boolean };
  hidden_canaries: string[];
  carr_checkout: string;
};
function parseEvidence(value: unknown): Evidence {
  assert.ok(
    value && typeof value === "object" && "client_read" in value && "receipt" in value && "hidden_canaries" in value,
  );
  const { client_read, receipt, hidden_canaries } = value;
  assert.ok(client_read && typeof client_read === "object" && !Array.isArray(client_read));
  assert.ok(
    receipt &&
      typeof receipt === "object" &&
      "id" in receipt &&
      typeof receipt.id === "string" &&
      "version" in receipt &&
      typeof receipt.version === "number" &&
      "published" in receipt &&
      typeof receipt.published === "boolean",
  );
  assert.ok(
    Array.isArray(hidden_canaries) &&
      hidden_canaries.length &&
      hidden_canaries.every((v: unknown) => typeof v === "string" && v.length > 0),
  );
  return {
    client_read: { ...client_read },
    receipt: { id: receipt.id, version: receipt.version, published: receipt.published },
    hidden_canaries,
    carr_checkout: "carr_checkout" in value && typeof value.carr_checkout === "string" ? value.carr_checkout : ".",
  };
}
export async function prove({
  origin,
  commit,
  carrOrigin,
  carrCommit,
  endpoint,
  deal,
  evidence,
  timeoutMs = 30000,
}: {
  origin: string;
  commit: string;
  carrOrigin: string;
  carrCommit: string;
  endpoint: string;
  deal: string;
  evidence: Evidence;
  timeoutMs?: number;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(unavailable("Proof deadline exceeded")), timeoutMs);
  let browser: { newPage(): Promise<Page>; close(): Promise<void> } | undefined;
  try {
    const release = await readAppRelease(origin, { timeoutMs });
    await requireContainingRelease(commit, release.source_commit, { signal: controller.signal });
    const response = await proofFetch(new URL("/release", carrOrigin), { signal: controller.signal });
    const carr = await response.json();
    if (!response.ok || typeof carr.git_sha !== "string") throw unavailable("CARR release unavailable");
    await requireContainingRelease(carrCommit, carr.git_sha, {
      signal: controller.signal,
      cwd: evidence.carr_checkout,
    });
    if (
      !evidence.client_read ||
      !evidence.receipt ||
      !Array.isArray(evidence.hidden_canaries) ||
      !evidence.hidden_canaries.length
    )
      throw unavailable("Existing client read, receipt and hidden canaries required");
    const client = parsePortal({ ...evidence.client_read, schema_version: "client-publications.v1" });
    if (!client) throw unavailable("Existing active portal required");
    browser = await launchProofBrowser(signedInEngine(endpoint), { timeout: timeoutMs }, { signal: controller.signal });
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    type Reads = { preview?: Portal | null; authored?: Publication[] };
    const reads: Reads = {};
    const currentReads = (): Reads => reads;
    const capture = async (response: BrowserResponse) => {
      try {
        if (new URL(response.url()).origin !== origin || new URL(response.url()).pathname !== "/mcp") return;
        const verb = JSON.parse(response.request().postData() || "{}").params;
        if (verb?.arguments?.deal_id !== deal) return;
        const result = await response.json();
        const value = JSON.parse(result.result.content.find((row: { type: string }) => row.type === "text").text);
        if (verb.name === "preview-deal-client-view") reads.preview = parsePortal(value);
        if (verb.name === "list-deal-client-publications") reads.authored = parsePublications(value);
      } catch {
        /* Missing evidence is refused below. */
      }
    };
    const observations = [];
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        delete reads.preview;
        delete reads.authored;
        page.on("response", capture);
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(`${origin}/deals?mode=live&deal=${encodeURIComponent(deal)}&tab=client-view`);
        await page.getByRole("tab", { name: "Client view", exact: true }).click();
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const root = page.locator("[data-client-preview]");
        await root.waitFor();
        page.off("response", capture);
        const { preview, authored } = currentReads();
        if (!preview || !authored) throw unavailable("Authenticated preview and authored read unavailable");
        assert.deepEqual(preview, client, "partner preview equals independent existing client projection");
        const expected: { title: string; body: string }[] = [...client.materials, ...client.publications].map(
          (row) => ({
            title: row.title,
            body:
              row.kind === "deliverable"
                ? `${row.deliverable.filename} · ${row.deliverable.mime} · ${row.deliverable.bytes} bytes`
                : row.content,
          }),
        );
        const actual = await root.locator("article").evaluateAll((rows) =>
          rows.map((row) => ({
            title: row.querySelector("h4")?.textContent,
            body: row.querySelector("p")?.textContent,
          })),
        );
        assert.deepEqual(actual, expected, "exact visible values");
        for (const hidden of evidence.hidden_canaries)
          assert.ok(!JSON.stringify(preview).includes(hidden), "hidden canary absent");
        const receipt = evidence.receipt;
        assert.ok(
          authored.some(
            (row) => row.id === receipt.id && row.version === receipt.version && row.published === receipt.published,
          ),
          "existing publication receipt persisted",
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          "no horizontal overflow",
        );
        observations.push({ width, theme, items: actual.length });
      }
    return { status: "passed", release, carr, observations };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await browser?.close();
  }
}
async function main() {
  try {
    const args = new Map<string, string>();
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i],
        value = process.argv[i + 1];
      if (!key || !value) throw unavailable("Named arguments required");
      args.set(key, value);
    }
    const required = (key: string) => {
      const value = args.get(key);
      if (!value) throw unavailable(`Missing ${key}`);
      return value;
    };
    const origin = new URL(required("--origin")).origin,
      carrOrigin = new URL(required("--carr-origin")).origin;
    const commit = required("--commit"),
      carrCommit = required("--carr-commit"),
      deal = required("--deal");
    if (
      !/^[a-f0-9]{40}$/.test(commit || "") ||
      !/^[a-f0-9]{40}$/.test(carrCommit || "") ||
      !/^[a-f0-9-]{36}$/.test(deal || "")
    )
      throw unavailable("Exact app/CARR commits and deal required");
    const evidence = parseEvidence(JSON.parse(await readFile(required("--evidence"), "utf8")));
    console.log(
      JSON.stringify(
        await prove({
          origin,
          carrOrigin,
          commit,
          carrCommit,
          deal,
          endpoint: required("--cdp-url"),
          evidence,
          timeoutMs: Number(args.get("--timeout-ms") || 30000),
        }),
      ),
    );
  } catch (cause) {
    const error = cause instanceof Error ? cause : Error("Proof unavailable");
    const exitCode = "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
    console.log(JSON.stringify({ status: exitCode === 78 ? "insufficient_evidence" : "failed", error: error.message }));
    process.exitCode = exitCode;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
