import assert from "node:assert/strict";
import test from "node:test";
import { walkV2Accessibility } from "../scripts/v2-accessibility-walk.ts";
import { chromium } from "./browser-harness.mjs";

const names = [
  "Home",
  "Deals board",
  "Deal",
  "Tours library",
  "Tour and cheat sheet",
  "Vendors Suggested",
  "Vendors Research",
  "Relationships",
  "Leads",
];
const tour =
  '<section id="tour-panel"><details id="internal-cheat-sheet"><summary>Cheat sheet</summary><div id="cheat-content">Notes</div></details></section>';

for (const scenario of [
  "standalone",
  "unstable identity",
  "embedded",
  "pagination",
  "incomplete pagination",
  "unavailable frame",
  "unavailable surface",
  "already open disclosures",
])
  test(`Walk transition coverage: ${scenario}`, async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const open = scenario === "already open disclosures";
    const embedded = scenario === "embedded" || scenario === "unavailable frame";
    const captures: string[] = [];
    let pages = 0;
    await page.route("http://walk.test/**", (route) => {
      const url = new URL(route.request().url());
      let body = '<button class="inbox-row">Inbox</button>';
      if (scenario === "unstable identity")
        body += `<a href="#" id="row" style="position:absolute;top:2200px;width:100px;height:60px"><span>Row</span></a><script>
          const observer = new IntersectionObserver(entries => {
            if (!entries.some(entry => entry.isIntersecting)) return;
            const row = document.getElementById('row');
            const replacement = row.cloneNode(true);
            replacement.setAttribute('href', '#different-action');
            row.replaceWith(replacement);
            observer.unobserve(row);
            observer.observe(replacement);
          });
          observer.observe(document.getElementById('row'));
        </script>`;
      if (scenario === "unavailable surface") body = "Unavailable";
      else if (url.pathname === "/deals" && url.search)
        body = '<iframe title="Tour shortlist, route and packet" src="/frame"></iframe>';
      else if (url.pathname === "/frame") body = open ? tour.replace("<details ", "<details open ") : tour;
      else if (url.pathname === "/deals")
        body =
          '<div class="kanban-card"><button class="card-open" onclick="document.querySelector(\'#detailUpdateForm\').hidden=false">Open Deal</button></div><form id="detailUpdateForm" hidden><button>Update</button></form>';
      else if (url.pathname === "/tours")
        body = `<a class="tour-button" href="${embedded ? "/deals?tour=1" : "/tours/route-editor.html"}">Tour</a>`;
      else if (url.pathname === "/tours/route-editor.html")
        body = `<button class="tour-button">Open Tour</button>${open ? tour.replace("<details ", "<details open ") : tour}`;
      else if (url.pathname === "/vendors")
        body = `<details ${open ? "open" : ""} class="vendor-meetings"><summary>People</summary><section role="region" aria-label="People worth meeting"><button role="tab">Suggested</button><button role="tab">Research</button></section></details><ul id="recordList"><li><button>Vendor</button></li></ul><div id="scrollSentinel" ${scenario.includes("pagination") ? "" : "hidden"}>More</div>`;
      else if (url.pathname === "/relationships") body = '<button id="networkRefresh">Refresh</button>';
      else if (url.pathname === "/leads") body = '<button class="lead-card">Lead</button>';
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><head><title>Walk</title><style>button,a,summary{display:block;min-width:60px;min-height:60px}iframe{width:100%;height:500px}</style></head><body><main><h1>Walk</h1>${body}</main></body></html>`,
      });
    });
    const locate = page.locator.bind(page);
    page.locator = (selector, options) => {
      const locator = locate(selector, options);
      if (selector === "#scrollSentinel" && scenario.includes("pagination")) {
        locator.scrollIntoViewIfNeeded = async () => {
          pages++;
          await page.evaluate((hide) => {
            const item = document.createElement("li");
            item.innerHTML = "<button>Next vendor</button>";
            document.querySelector("#recordList")?.append(item);
            if (hide) document.querySelector("#scrollSentinel")?.setAttribute("hidden", "");
          }, scenario === "pagination");
        };
      }
      if (selector === 'iframe[title="Tour shortlist, route and packet"]' && scenario === "unavailable frame") {
        const handle = locator.elementHandle.bind(locator);
        locator.elementHandle = async (options) => {
          const element = await handle(options);
          element.contentFrame = async () => null;
          return element;
        };
      }
      return locator;
    };
    const walk = () =>
      walkV2Accessibility(page, "http://walk.test", async (name) => {
        captures.push(name);
        if (name === "Tour and cheat sheet") {
          const frame = embedded ? page.frames().find((frame) => frame.url().endsWith("/frame")) : page.mainFrame();
          assert.ok(frame);
          assert.equal(await frame.locator("#cheat-content").isVisible(), true);
        }
      });
    if (scenario === "unstable identity") {
      await assert.rejects(walk, /unstable-identity/);
      assert.deepEqual(captures, []);
    } else if (scenario === "unavailable frame") {
      await assert.rejects(walk, /Tour editor frame unavailable/);
      assert.deepEqual(captures, names.slice(0, 4));
    } else if (scenario === "incomplete pagination") {
      await assert.rejects(walk, /incomplete after 20 pages/);
      assert.equal(pages, 20);
      assert.deepEqual(captures, names.slice(0, 5));
    } else if (scenario === "unavailable surface") {
      await assert.rejects(walk, /Timeout 10000ms exceeded/);
      assert.deepEqual(captures, []);
    } else {
      const rows = await walk();
      assert.deepEqual(
        rows.map((row) => row.name),
        names,
      );
      assert.deepEqual(captures, names);
      assert.equal(pages, scenario === "pagination" ? 1 : 0);
      for (const row of rows) {
        assert.deepEqual(row.small, []);
        assert.deepEqual(row.covered, []);
      }
    }
  });
