import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { startFixture } from "../scripts/fixture-http.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import recorded from "./fixtures/tour-stop-drag.json" with { type: "json" };
import { buildToursAppScript } from "./tours-app-loader.ts";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export function fixturePath(requestPath: string) {
  const decoded = decodeURIComponent(requestPath);
  const resolved = path.resolve(root, `.${decoded}`);
  if (!decoded.startsWith("/") || decoded.includes("\\") || !resolved.startsWith(root + path.sep))
    throw Error("Fixture path outside root");
  return resolved;
}
export const fixtureDeal = "11111111-1111-4111-8111-111111111111";
export const propA = "44444444-4444-4444-8444-444444444444";
export const propB = "55555555-5555-4555-8555-555555555555";
export type FixtureMode = "pass" | "cancelled" | "near-miss";
export async function tourDragRoutes(mode: FixtureMode = "pass") {
  const read = (name: string) => readFile(fixturePath(name), "utf8");
  const routes = new Map<string, { contentType: string; body: string }>();
  const add = (name: string, contentType: string, body: string) => {
    fixturePath(name);
    routes.set(name, { contentType, body });
  };
  for (const [name, body] of [
    ["library", recorded.library],
    ["detail", recorded.detail],
  ] as const)
    add(`/api/tours/${name}`, "application/json", JSON.stringify(body));
  add(
    "/app-release",
    "application/json",
    JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: "1".repeat(40) }),
  );
  add(
    "/deals",
    "text/html",
    `<iframe title="Tour shortlist, route and packet" style="border:0;width:100%;height:10000px" src="/tours/route-editor.html?deal=${fixtureDeal}&tour=${recorded.detail.data.id}"></iframe>`,
  );
  const html = new JSDOM(await read("/tours/route-editor.html"));
  try {
    for (const node of html.window.document.querySelectorAll("script, link")) node.remove();
    const style = html.window.document.createElement("style");
    style.textContent = (
      await Promise.all(["/css/tokens.css", "/tours/app.css", "/tours/property-panel.css"].map(read))
    ).join("\n");
    html.window.document.head.append(style);
    const script = html.window.document.createElement("script");
    script.textContent = await buildToursAppScript();
    html.window.document.body.append(script);
    if (mode !== "pass") {
      const fault = html.window.document.createElement("script");
      fault.textContent =
        mode === "cancelled"
          ? 'document.addEventListener("pointerup",e=>e.stopImmediatePropagation(),true)'
          : 'document.addEventListener("pointerup",()=>queueMicrotask(()=>{const row=document.querySelector("#route-stops > li");row.dataset.propertyId += "-near-miss";}))';
      html.window.document.body.append(fault);
    }
    add("/tours/route-editor.html", "text/html", html.serialize());
  } finally {
    html.window.close();
  }
  return routes;
}
export async function runTourDragProofFixture(
  routes: Awaited<ReturnType<typeof tourDragRoutes>>,
  context: TestContext,
  missingSession = false,
) {
  const server = await startFixture({ routes });
  try {
    const directory = temporaryDirectory("tour-drag-proof-", context);
    const storage = `${directory}/state.json`;
    if (!missingSession) await writeFile(storage, JSON.stringify({ cookies: [], origins: [] }));
    return await promisify(execFile)(
      process.execPath,
      [
        "scripts/prove-tour-stop-drag.ts",
        "--origin",
        server.origin,
        "--expected-commit",
        "1".repeat(40),
        "--tour-url",
        `${server.origin}/deals?deal=${fixtureDeal}`,
        "--storage-state",
        storage,
        "--timeout-ms",
        "30000",
      ],
      { timeout: 40000 },
    );
  } finally {
    await server.close();
  }
}
