import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { startFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import { propA, propB, runTourDragProofFixture, tourDragRoutes } from "./tour-stop-drag-proof-fixture.ts";

for (const mode of ["pass", "cancelled", "near-miss"] as const) {
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
  for (const theme of ["light", "dark"] as const) {
    test(`mouse and touch drag preserve exact order and Undo at ${width}px ${theme}`, async (t) => {
      const server = await startFixture({ routes: await tourDragRoutes() });
      t.after(() => server.close());
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: true, colorScheme: theme });
        await page.goto(`${server.origin}/deals`);
        const editor = page.frames().find((frame) => frame.url().includes("/tours/route-editor.html"));
        assert.ok(editor);
        await editor.locator("#route-editing").evaluate((node) => {
          if (node instanceof HTMLDetailsElement) node.open = true;
        });
        await editor.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        const touch = await page.context().newCDPSession(page);
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
          assert.equal(server.requests.filter((request) => !["GET", "HEAD"].includes(request.method ?? "")).length, 0);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        } finally {
          await touch.detach();
        }
      } finally {
        await browser.close();
      }
    });
  }
