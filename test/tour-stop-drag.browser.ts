import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { installDragReadGuard } from "../scripts/drag-read-guard.ts";
import { chromium } from "./browser-harness.mjs";
import {
  propA,
  propB,
  runTourDragProofFixture,
  startTourDragFixture,
  tourDragRoutes,
} from "./tour-stop-drag-proof-fixture.ts";

for (const mode of ["pass", "cancelled", "near-miss", "write", "unknown-verb", "unknown-post"] as const) {
  test(`production drag proof CLI fixture ${mode}`, async (t) => {
    const run = runTourDragProofFixture(await tourDragRoutes(mode), t);
    if (mode === "pass") {
      const { stdout } = await run;
      const result = JSON.parse(stdout);
      assert.equal(result.observations.length, 4);
      assert.equal(result.writes, 0);
    } else {
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && "stderr" in error);
        assert.equal(error.code, 1, String(error.stderr));
        if (mode === "near-miss") assert.match(String(error.stderr), /-near-miss/);
        if (["write", "unknown-verb", "unknown-post"].includes(mode))
          assert.match(String(error.stderr), /writes during drag/);
        return true;
      });
    }
  });
}
test("production drag proof missing stored session exits 78 on a containing release", async (t) => {
  await assert.rejects(runTourDragProofFixture(await tourDragRoutes(), t, true), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && "stderr" in error);
    assert.equal(error.code, 78, String(error.stderr));
    assert.match(String(error.stderr), /session|evidence/i);
    return true;
  });
});
for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`embedded drag edge scroll keeps property hit testing aligned at ${width}px ${theme}`, async () => {
      const built = await build({
        entryPoints: ["src/ui/tour-stop-drag.ts"],
        bundle: true,
        write: false,
        format: "iife",
        globalName: "TourStopDrag",
      });
      const dragScript = built.outputFiles[0]?.text;
      assert.ok(dragScript);
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
        await page.setContent(
          '<iframe title="Synthetic composer" style="border:0;width:350px;height:2600px" srcdoc="<ol id=list></ol>"></iframe>',
        );
        const frame = page.frames().find((f) => f !== page.mainFrame());
        assert.ok(frame);
        await frame.addScriptTag({ content: dragScript });
        await frame.evaluate(() => {
          const list = document.querySelector<HTMLOListElement>("#list");
          if (!list) throw Error("List missing");
          for (const id of ["a", "b", "c", "d"]) {
            const row = document.createElement("li");
            row.dataset.propertyId = id;
            row.dataset.flexibleStop = "";
            row.style.height = "600px";
            row.innerHTML = '<button data-stop-drag style="touch-action:none;height:44px">Drag</button>';
            list.append(row);
          }
          list.dataset.moves = "[]";
        });
        await frame.addScriptTag({
          content: `const list = document.querySelector('#list'); TourStopDrag.mountStopDrag(list, {editable: () => true, move: (source, target) => {const moves = JSON.parse(list.dataset.moves); moves.push([source,target]); list.dataset.moves = JSON.stringify(moves);}});`,
        });
        const start = await frame.locator("[data-stop-drag]").first().boundingBox();
        assert.ok(start);
        await page.mouse.move(start.x + 15, start.y + 15);
        await page.mouse.down();
        const before = await page.evaluate(() => scrollY);
        await page.mouse.move(start.x + 15, 895);
        await page.waitForFunction((y) => scrollY > y + 80, before);
        await frame.locator('[data-property-id="c"]').evaluate((el) => el.scrollIntoView({ block: "center" }));
        const target = await frame.locator('[data-property-id="c"]').boundingBox();
        assert.ok(target);
        await page.mouse.move(target.x + 20, 400);
        await page.mouse.up();
        assert.deepEqual(JSON.parse((await frame.locator("#list").getAttribute("data-moves")) ?? "null"), [["a", "c"]]);
        await frame.locator("[data-stop-drag]").first().scrollIntoViewIfNeeded();
        const cancelStart = await frame.locator("[data-stop-drag]").first().boundingBox();
        assert.ok(cancelStart);
        await page.mouse.move(cancelStart.x + 10, cancelStart.y + 10);
        await page.mouse.down();
        await page.keyboard.press("Escape");
        await page.mouse.up();
        assert.equal(await frame.locator(".stop-dragging").count(), 0);
        assert.deepEqual(JSON.parse((await frame.locator("#list").getAttribute("data-moves")) ?? "null"), [["a", "c"]]);
      } finally {
        await browser.close();
      }
    });

for (const width of [390, 1440])
  for (const [theme, latency] of [
    ["light", 0],
    ["dark", 0],
    ["light", 250],
  ] as const) {
    test(`mouse and touch drag preserve exact order and Undo at ${width}px ${theme}${latency ? " with slow network" : ""}`, async (t) => {
      const server = await startTourDragFixture(await tourDragRoutes());
      t.after(() => server.close());
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: true, colorScheme: theme });
        const touch = await page.context().newCDPSession(page);
        if (latency) {
          await touch.send("Network.enable");
          await touch.send("Network.emulateNetworkConditions", {
            offline: false,
            latency,
            downloadThroughput: 10000000,
            uploadThroughput: 10000000,
          });
        }
        const guard = await installDragReadGuard(page.context(), server.origin);
        await page.goto(`${server.origin}/deals`);
        const editor = page.frames().find((frame) => frame.url().includes("/tours/route-editor.html"));
        assert.ok(editor);
        await editor.locator("#route-editing").evaluate((node) => {
          if (node instanceof HTMLDetailsElement) node.open = true;
        });
        await editor.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        try {
          for (const input of ["mouse", "touch"]) {
            const handle = editor.locator(`[data-property-id="${propA}"] [data-stop-drag]`);
            await handle.scrollIntoViewIfNeeded();
            const box = await handle.boundingBox();
            assert.ok(box);
            const x = box.x + box.width / 2,
              y = box.y + box.height / 2;
            if (input === "mouse") {
              await page.mouse.move(x, y);
              await page.mouse.down();
            } else await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
            const destination = editor.locator(`[data-property-id="${propB}"] .stop-head`);
            await destination.evaluate((node) => node.scrollIntoView({ block: "center" }));
            const target = await destination.boundingBox();
            assert.ok(target);
            const tx = target.x + target.width / 2,
              ty = target.y + target.height / 2;
            if (input === "mouse") {
              await page.mouse.move(tx, ty);
              await page.mouse.up();
            } else {
              await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: tx, y: ty }] });
              await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            }
            const order = (): Promise<(string | null)[]> =>
              editor
                .locator("#route-stops > li")
                .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-property-id")));
            assert.deepEqual(await order(), [propB, propA]);
            await editor.locator("#undo-route").click();
            assert.deepEqual(await order(), [propA, propB]);
          }
          await editor.locator("[data-stop-drag]").first().scrollIntoViewIfNeeded();
          const box = await editor.locator("[data-stop-drag]").first().boundingBox();
          assert.ok(box);
          await page.mouse.move(box.x + 10, box.y + 10);
          await page.mouse.down();
          await page.keyboard.press("Escape");
          await page.mouse.up();
          assert.equal(await editor.locator(".stop-dragging").count(), 0);
          assert.notEqual(
            await editor
              .locator('[data-field="dwell_minutes"]')
              .first()
              .evaluate((node) => getComputedStyle(node).touchAction),
            "none",
          );
          assert.equal(guard.writes, 0, "no writes during drag");
          assert.ok(server.rpcReads > 0, "saved-search startup read reaches the contract fixture");
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        } finally {
          await touch.detach();
        }
      } finally {
        await browser.close();
      }
    });
  }

for (const releaseDuring of ["scroll", "drag"])
  for (const releaseAfter of [0, 1, 5, 10, 20, 40]) {
    test(`late selection cart preserves the drag target during ${releaseDuring} after ${releaseAfter}ms`, async (t) => {
      const server = await startTourDragFixture(await tourDragRoutes());
      t.after(() => server.close());
      const browser = await chromium.launch();
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let received = () => {};
      const seen = new Promise<void>((resolve) => {
        received = resolve;
      });
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true });
        await page.route("**/api/tours/selection-cart?*", async (route) => {
          received();
          await held;
          await route.continue();
        });
        await page.goto(`${server.origin}/deals`);
        await seen;
        const editor = page.frames().find((frame) => frame.url().includes("/tours/route-editor.html"));
        assert.ok(editor);
        await editor.locator("#route-editing").evaluate((node) => {
          if (node instanceof HTMLDetailsElement) node.open = true;
        });
        const handle = editor.locator(`[data-property-id="${propA}"] [data-stop-drag]`);
        const original = await handle.elementHandle();
        assert.ok(original);
        const response = page.waitForResponse((response) => response.url().includes("/api/tours/selection-cart?"));
        const scrolling = handle.scrollIntoViewIfNeeded();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (releaseDuring === "scroll") timer = setTimeout(release, releaseAfter);
          await scrolling;
          assert.equal(await handle.isEnabled(), true, "route editing does not wait for the selection cart");
          if (releaseDuring === "scroll") await (await response).finished();
          assert.ok(
            await original.evaluate((node) => node.isConnected),
            "late cart read must keep the original handle attached",
          );
          assert.equal(await handle.isEnabled(), true, "route editing does not wait for the selection cart");
          const box = await handle.boundingBox();
          assert.ok(box);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          if (releaseDuring === "drag") {
            timer = setTimeout(release, releaseAfter);
            await (await response).finished();
            assert.ok(await original.evaluate((node) => node.isConnected));
          }
          const destination = editor.locator(`[data-property-id="${propB}"] .stop-head`);
          await destination.evaluate((node) => node.scrollIntoView({ block: "center" }));
          const target = await destination.boundingBox();
          assert.ok(target);
          await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
          await page.mouse.up();
          const order = () =>
            editor
              .locator("#route-stops > li")
              .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-property-id")));
          assert.deepEqual(await order(), [propB, propA]);
          await editor.locator("#undo-route").click();
          assert.deepEqual(await order(), [propA, propB]);
        } finally {
          clearTimeout(timer);
        }
      } finally {
        release();
        await browser.close();
      }
    });
  }
