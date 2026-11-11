import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const { mountMorningBrief } = await import(new URL("../js/morning-brief.js", import.meta.url).href);

test("Home mounts the shared brief inline without a blocking dialog", async () => {
  const dom = new JSDOM(
    '<button id="docOpen">Doc</button><button id="docMorning">Brief</button><div id="homeBrief" data-inline-morning-brief></div>',
    { url: "http://localhost/" },
  );
  const { window } = dom;
  const section = { state: "empty", items: [] };
  let reads = 0;
  const client = {
    morningBrief: async () => {
      reads++;
      return { sponsor: "joe", sections: { today: section, deals: section, loops: section } };
    },
    getChanges: async () => ({ events: [], cursor: null }),
  };
  const brief = mountMorningBrief({
    document: window.document,
    window,
    getClient: async () => client,
    intervalMs: 100000,
  });
  try {
    await brief.refresh();
    assert.equal(window.document.querySelector("dialog"), null);
    assert.ok(window.document.querySelector("#homeBrief #docMorningBrief"));
    assert.equal(window.document.querySelector<HTMLElement>("#docMorningBrief")?.hidden, false);
    const before = reads;
    window.document.getElementById("docMorning")?.click();
    await brief.refresh();
    assert.ok(reads <= before + 1);
    assert.match(window.document.getElementById("morningTitle")?.textContent || "", /Joe/);
  } finally {
    brief.dispose();
    window.close();
  }
});

test("rail and inline owner coalesce reads and retire late private responses", async () => {
  const { readMorningBrief } = await import(new URL("../js/morning-brief.js", import.meta.url).href);
  const dom = new JSDOM("", { url: "http://localhost/" });
  const section = { state: "empty", items: [] };
  const payload = (sponsor: string) => ({ sponsor, sections: { today: section, deals: section, loops: section } });
  let resolve: (value: unknown) => void = () => {};
  let reads = 0;
  const read = () => {
    reads++;
    return new Promise((yes) => {
      resolve = yes;
    });
  };
  try {
    const first = readMorningBrief(dom.window.document, read);
    const second = readMorningBrief(dom.window.document, read);
    assert.equal(reads, 1);
    dom.window.dispatchEvent(new dom.window.Event("doctorcre-session-invalidated"));
    const current = await readMorningBrief(dom.window.document, async () => payload("dell"));
    resolve(payload("joe"));
    await assert.rejects(first, /retired/);
    await assert.rejects(second, /retired/);
    assert.equal(current.sponsor, "dell");
    assert.equal((await readMorningBrief(dom.window.document, read)).sponsor, "dell");
    assert.equal(reads, 1);
    await assert.rejects(
      readMorningBrief(
        dom.window.document,
        async () => {
          throw Error("Unavailable");
        },
        { fresh: true },
      ),
    );
    assert.equal((await readMorningBrief(dom.window.document, async () => payload("joe"))).sponsor, "joe");
  } finally {
    dom.window.close();
  }
});
