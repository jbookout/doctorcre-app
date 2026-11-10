import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// jsdom exposes a browser document and close through its Node constructor.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: Window & { close(): void } };
};

import { readFile } from "node:fs/promises";
import { uiBundle } from "../scripts/ui-bundle.mjs";
import type { createBriefQueueView as ViewFactory } from "../src/ui/brief-queues.tsx";

const bundle = await uiBundle((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8"));
// The generated bundle exports the same view interface as its typed source.
const { createBriefQueueView } = (await import(`data:text/javascript;base64,${bundle.toString("base64")}`)) as {
  createBriefQueueView: typeof ViewFactory;
};

test("malformed section coverage preserves menu, replacement counts and disposal", () => {
  const dom = new JSDOM("<nav></nav><main></main>");
  const menu = dom.window.document.querySelector("nav");
  const content = dom.window.document.querySelector("main");
  assert.ok(menu && content);
  const view = createBriefQueueView(menu, content);
  try {
    for (const sections of [
      null,
      undefined,
      {},
      { today: null },
      ...[null, {}, "bad", 2].map((items) => ({ today: { items, total: 1 } })),
      ...[undefined, null, "0", -1, 0.5, NaN, Infinity, 9007199254740992].map((total) => ({
        today: { items: [], total },
      })),
      { today: { items: [{}], total: 0 } },
    ]) {
      view.renderMenu({ sponsor: "joe", sections });
      assert.equal(menu.querySelectorAll("button").length, 4);
      assert.match(menu.querySelector("[data-brief-queue=today]")?.textContent || "", /coverage unknown/);
      assert.doesNotMatch(menu.textContent || "", /No eligible work|0 of 0/);
      view.renderMenu({ sponsor: "joe", sections });
      assert.match(menu.querySelector("[data-brief-queue=today]")?.textContent || "", /coverage unknown/);
      view.renderMenu({ sponsor: "joe", sections }, "loops");
      assert.equal(menu.querySelector<HTMLSelectElement>("select")?.value, "loops");
      view.renderMenu({ sponsor: "joe", sections });
      assert.equal(menu.querySelectorAll("button").length, 4);
      assert.match(menu.querySelector("[data-brief-queue=today]")?.textContent || "", /coverage unknown/);
      view.renderMenu({ sponsor: "joe", sections: { today: { items: [{}], total: 3 } } });
      assert.match(menu.querySelector("[data-brief-queue=today]")?.textContent || "", /1 of 3/);
    }
    for (const [state, suffix] of [
      ["empty", ""],
      ["partial", " · Some sources are unavailable"],
      ["unavailable", " · Unavailable"],
    ] as const) {
      view.renderMenu({ sponsor: "joe", sections: { today: { state, items: [], total: 0 } } });
      assert.equal(menu.querySelector("[data-brief-queue=today]")?.textContent || "", `Today queue · 0 of 0${suffix}`);
    }
    view.renderMenu({ sponsor: "dell", sections: null });
    assert.equal(menu.querySelectorAll("button").length, 3);
    assert.equal(menu.querySelector("[data-brief-queue=needs_joe]"), null);
    view.dispose();
    assert.equal(menu.childElementCount, 0);
  } finally {
    view.dispose();
    dom.window.close();
  }
});

for (const [count, total] of [
  [0, 0],
  [1, 3],
] as const) {
  test(`accurate ${count} of ${total} replacement disposes both mounted hosts`, () => {
    const dom = new JSDOM("<nav></nav><main></main>");
    const menu = dom.window.document.querySelector("nav");
    const content = dom.window.document.querySelector("main");
    assert.ok(menu && content);
    const view = createBriefQueueView(menu, content);
    const facts = { sponsor: "joe", sections: { today: { items: Array(count).fill({}), total } } };
    try {
      view.renderMenu({ sponsor: "joe", sections: null });
      view.renderMenu(facts);
      assert.equal(
        menu.querySelector("[data-brief-queue=today]")?.textContent || "",
        `Today queue · ${count} of ${total}`,
      );
      view.renderMenu(facts, "today");
      assert.equal(menu.querySelector<HTMLSelectElement>("select")?.value, "today");
      view.renderMenu(facts);
      assert.equal(
        menu.querySelector("[data-brief-queue=today]")?.textContent || "",
        `Today queue · ${count} of ${total}`,
      );
      view.renderList({
        active: "today",
        items: [],
        page: { total: 0, has_more: false, state: "empty" },
        busy: false,
        error: false,
      });
      assert.equal(menu.querySelectorAll("button").length, 4);
      assert.ok(content.childElementCount > 0);
      view.dispose();
      assert.equal(menu.childElementCount, 0, "accurate menu unmounts");
      assert.equal(content.childElementCount, 0, "queue content unmounts");
    } finally {
      view.dispose();
      dom.window.close();
    }
  });
}
