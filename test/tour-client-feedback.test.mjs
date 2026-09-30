import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";

const share = readFileSync(new URL("../reports/share.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../reports/share.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../reports/share.css", import.meta.url), "utf8");
const tours = readFileSync(new URL("../tours/app.js", import.meta.url), "utf8");
const tourHtml = readFileSync(new URL("../tours/index.html", import.meta.url), "utf8");

const propertyRef = "property:public:synthetic_property_01";
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function openShare({ items = [], refuseOnce = false } = {}) {
  const dom = new JSDOM(html, { url: "https://reports.doctorcre.com/share", runScripts: "outside-only" });
  Object.defineProperty(dom.window, "crypto", { value: webcrypto });
  const writes = [];
  dom.window.fetch = async (path, options = {}) => {
    let data;
    if (path === "/api/share/report") data = { items: [{ property_ref: propertyRef, name: "Demo medical office" }] };
    else if (path === "/api/share/map") data = { points: [] };
    else if (path === "/api/share/feedback") data = { projection_ref: "projection:public:synthetic_projection", permission_scopes: ["shortlist", "comment"], ...(items === null ? {} : { items }) };
    else if (path === "/api/share/shortlist" || path === "/api/share/comment") {
      writes.push({ path, ...JSON.parse(options.body) });
      if (refuseOnce) { refuseOnce = false; return { ok: false, json: async () => ({ error: "unavailable" }) }; }
      data = {};
    } else throw new Error(`Unexpected share request: ${path}`);
    return { ok: true, json: async () => ({ data: structuredClone(data) }) };
  };
  dom.window.eval(share);
  await settle();
  return { dom, doc: dom.window.document, writes };
}

test("an acknowledged first shortlist choice redraws the control and the next click removes it", async t => {
  const app = await openShare();
  t.after(() => app.dom.window.close());
  const button = () => app.doc.querySelector("button[aria-pressed]");
  assert.equal(button().getAttribute("aria-pressed"), "false");
  button().click();
  await settle();
  assert.equal(app.doc.querySelector("#feedback-status").textContent, "Shortlist saved.");
  assert.equal(button().textContent, "Remove from shortlist");
  assert.equal(button().getAttribute("aria-pressed"), "true");
  button().click();
  await settle();
  assert.equal(button().textContent, "Add to shortlist");
  assert.equal(button().getAttribute("aria-pressed"), "false");
  assert.deepEqual(app.writes.map(write => write.shortlisted), [true, false]);
  assert.ok(app.writes.every(write => write.property_ref === propertyRef));
});

test("a refused shortlist save retains the unselected control and retries the same logical write", async t => {
  const app = await openShare({ refuseOnce: true });
  t.after(() => app.dom.window.close());
  const button = () => app.doc.querySelector("button[aria-pressed]");
  button().click();
  await settle();
  assert.equal(button().getAttribute("aria-pressed"), "false");
  assert.equal(button().disabled, false);
  assert.match(app.doc.querySelector("#feedback-status").textContent, /could not be saved/);
  button().click();
  await settle();
  assert.equal(button().getAttribute("aria-pressed"), "true");
  assert.equal(app.writes[0].idempotency_key, app.writes[1].idempotency_key);
});

test("a first comment appears even when the feedback response omits property rows", async t => {
  const app = await openShare({ items: null });
  t.after(() => app.dom.window.close());
  const input = app.doc.querySelector("textarea");
  input.value = "Demo: please check the parking.";
  [...app.doc.querySelectorAll("button")].find(button => button.textContent === "Save comment").click();
  await settle();
  assert.equal(app.doc.querySelector(".comment-list").textContent, input.value);
  assert.equal(app.writes[0].comment, input.value);
});

test("both feedback diagrams give phone stage labels a 12px floor after SVG scaling", () => {
  // Inspect the stylesheet through the DOM CSS parser, including active phone
  // media rules. The independent target is a 12px screen label, not a source size.
  for (const [markup, styles, svgSelector, labelSelector, canvasWidth] of [
    [html, css, ".tour-flow svg", ".tour-flow g text:last-child", 278],
    [tourHtml, readFileSync(new URL("../tours/app.css", import.meta.url), "utf8"), ".feedback-flow", ".feedback-flow text", 266],
  ]) {
    const dom = new JSDOM(markup);
    try {
      const { document } = dom.window;
      const style = document.createElement("style"); style.textContent = styles; document.head.append(style);
      const svg = document.querySelector(svgSelector);
      const viewWidth = Number(svg.getAttribute("viewBox").split(/\s+/)[2]);
      let phoneFontSize = 10;
      for (const rule of style.sheet.cssRules) {
        if (!rule.conditionText || !/max-width\s*:\s*(\d+)px/.test(rule.conditionText)) continue;
        if (Number(rule.conditionText.match(/max-width\s*:\s*(\d+)px/)[1]) < 320) continue;
        for (const phoneRule of rule.cssRules) {
          if (phoneRule.selectorText === labelSelector && phoneRule.style.getPropertyValue("font-size"))
            phoneFontSize = parseFloat(phoneRule.style.getPropertyValue("font-size"));
        }
      }
      assert.ok(phoneFontSize * canvasWidth / viewWidth >= 12,
        `${labelSelector} shrinks below 12px on a 320px phone`);
    } finally { dom.window.close(); }
  }
});

test("client feedback appears only after an opened share and uses opaque refs", () => {
  assert.match(share, /\/api\/share\/feedback/);
  assert.match(share, /request\(`\/api\/share\/\$\{kind\}`/);
  assert.match(share, /projection_ref/);
  assert.match(share, /property_ref/);
  assert.match(share, /idempotency_key/);
  assert.doesNotMatch(share, /saved\.data\?\.comment_ref/);
  assert.match(html, /id="feedback-status"/);
  assert.doesNotMatch(share + html, /broker_notes|source_evidence_id|property_id|share_grant_id/);
  assert.doesNotMatch(share, /localStorage|sessionStorage|sendBeacon/);
});

test("broker feedback is confined to the authenticated Tours view", () => {
  assert.match(tours, /\/api\/tours\/feedback\?projection_id=/);
  assert.match(tourHtml, /id="client-feedback"/);
  assert.match(tourHtml, /<svg[\s\S]*<\/svg>/);
  assert.match(css, /color-scheme: dark/);
  assert.match(css, /backdrop-filter: blur/);
  assert.match(css, /prefers-reduced-motion/);
});
