import { routeDraftScript } from "./tours-route-draft-script.mjs";
import { autoRefreshScript } from "./auto-refresh-script.mjs";
import { mapScript } from "./tours-map-script.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { openDom } from "./jsdom-harness.mjs";

const share = readFileSync(new URL("../reports/share.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../reports/share.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../reports/share.css", import.meta.url), "utf8");
const tours = readFileSync(new URL("../tours/app.js", import.meta.url), "utf8");
const tourHtml = readFileSync(new URL("../tours/route-editor.html", import.meta.url), "utf8");

const propertyRef = "property:public:synthetic_property_01";
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const shortlistAction = (doc, label = "Add to shortlist") => [...doc.querySelectorAll("button")].find(button => button.textContent === label);
const tourIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const projectionIds = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const tourFormat = readFileSync(new URL("../tours/tour-format.js", import.meta.url), "utf8").replace(/^export /gm, "");
const propertyPanel = readFileSync(new URL("../tours/property-panel.js", import.meta.url), "utf8").replace(/^export /gm, "");
const tourScript = `${routeDraftScript}\n${autoRefreshScript}\n${mapScript}\nconst mountPropertyPanel = (() => { ${propertyPanel}\nreturn mountPropertyPanel; })();\n${tourFormat}\n${tours.replace(/^import [^\n]*\n/gm, "")}`;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function feedbackResponse(label) {
  return { ok: true, json: async () => ({ data: { feedback: { items: [{ route_label: label, shortlisted: true, comments: [{ comment: `${label} comment` }] }] } } }) };
}
async function openBroker(feedbackRead, { stops = [], detailRead = null } = {}) {
  const dom = openDom(tourHtml, { url: "https://app.doctorcre.com/tours", runScripts: "outside-only" });
  dom.window.TextEncoder = TextEncoder;
  const counts = [0, 0], reads = [];
  dom.window.fetch = async path => {
    const url = new URL(path, dom.window.location.href);
    reads.push(url.pathname);
    let data;
    if (url.pathname === "/api/tours/library") data = { tours: tourIds.map((id, i) => ({ id, name: `Demo Tour ${i ? "B" : "A"}` })) };
    else if (url.pathname === "/api/tours/detail") {
      const i = tourIds.indexOf(url.searchParams.get("tour_id"));
      data = { id: tourIds[i], name: `Demo Tour ${i ? "B" : "A"}`, projection_id: projectionIds[i], stops };
      if (detailRead) data = detailRead(data);
    } else if (url.pathname === "/api/tours/selection-cart") {
      return { ok: false, json: async () => ({ error: "not_found" }) };
    } else if (url.pathname === "/api/tours/feedback") {
      const i = projectionIds.indexOf(url.searchParams.get("projection_id"));
      return feedbackRead(i, ++counts[i]);
    } else throw new Error(`Unexpected broker request: ${path}`);
    return { ok: true, json: async () => ({ data }) };
  };
  dom.window.eval(tourScript);
  await settle();
  return { dom, doc: dom.window.document, reads };
}

test("a late feedback Refresh cannot replace the selected Tour's responses", async t => {
  const held = deferred();
  const app = await openBroker((i, count) => i === 0 && count === 2 ? held.promise : feedbackResponse(i ? "B response" : "A response"));
  const buttons = app.doc.querySelectorAll(".tour-button");
  buttons[0].click(); await settle();
  app.doc.querySelector("#refresh-feedback").click(); await settle();
  buttons[1].click(); await settle();
  assert.equal(app.doc.querySelector("#tour-name").textContent, "Demo Tour B");
  assert.match(app.doc.querySelector("#feedback-list").textContent, /B response comment/);
  held.resolve(feedbackResponse("A late response")); await settle();
  assert.match(app.doc.querySelector("#feedback-list").textContent, /B response comment/);
  assert.doesNotMatch(app.doc.querySelector("#feedback-list").textContent, /A late response/);
});

test("a late earlier Refresh cannot replace newer feedback for the same projection", async t => {
  const held = deferred();
  const app = await openBroker((i, count) => count === 2 ? held.promise : feedbackResponse(count === 3 ? "Newest response" : "Initial response"));
  app.doc.querySelector(".tour-button").click(); await settle();
  app.doc.querySelector("#refresh-feedback").click(); await settle();
  app.doc.querySelector("#refresh-feedback").click(); await settle();
  held.resolve(feedbackResponse("Older response")); await settle();
  assert.match(app.doc.querySelector("#feedback-list").textContent, /Newest response/);
  assert.doesNotMatch(app.doc.querySelector("#feedback-list").textContent, /Older response/);
});

test("a failed initial feedback read shows unavailable and Refresh can confirm an empty response", async t => {
  const app = await openBroker((i, count) => count === 1
    ? { ok: false, json: async () => ({ error: "unavailable" }) }
    : { ok: true, json: async () => ({ data: { feedback: { items: [] } } }) });
  app.doc.querySelector(".tour-button").click(); await settle();
  assert.equal(app.doc.querySelector("#feedback-empty").hidden, true);
  assert.match(app.doc.querySelector("#client-feedback").textContent, /Client responses temporarily unavailable/);
  assert.notEqual(app.doc.querySelector("#status").textContent, "Tour ready.");
  app.doc.querySelector("#refresh-feedback").click(); await settle();
  assert.equal(app.doc.querySelector("#feedback-empty").hidden, false);
  assert.doesNotMatch(app.doc.querySelector("#feedback-state").textContent, /unavailable/);
});

test("loading and a failed feedback Refresh never claim a successful empty read", async t => {
  const held = deferred();
  const app = await openBroker((i, count) => count === 2 ? held.promise : feedbackResponse("Confirmed response"));
  app.doc.querySelector(".tour-button").click(); await settle();
  app.doc.querySelector("#refresh-feedback").click(); await settle();
  assert.match(app.doc.querySelector("#feedback-state")?.textContent || "", /Loading client responses/);
  assert.equal(app.doc.querySelector("#feedback-empty").hidden, true);
  assert.equal(app.doc.querySelector("#feedback-list").getAttribute("aria-busy"), "true");
  held.resolve({ ok: false, json: async () => ({ error: "unavailable" }) }); await settle();
  assert.equal(app.doc.querySelector("#feedback-empty").hidden, true);
  assert.match(app.doc.querySelector("#feedback-state").textContent, /temporarily unavailable/);
  assert.match(app.doc.querySelector("#status").textContent, /unavailable/);
  app.doc.querySelector("#refresh-feedback").click(); await settle();
  assert.match(app.doc.querySelector("#feedback-list").textContent, /Confirmed response/);
  assert.equal(app.doc.querySelector("#feedback-list").getAttribute("aria-busy"), "false");
  assert.doesNotMatch(app.doc.querySelector("#status").textContent, /unavailable/);
});

test("reordering draft stops retains the sealed projection's loaded client responses", async t => {
  const app = await openBroker(() => feedbackResponse("Confirmed response"), { stops: [
    { id: tourIds[0], label: "Demo stop A" }, { id: tourIds[1], label: "Demo stop B" },
  ] });
  app.doc.querySelector(".tour-button").click(); await settle();
  [...app.doc.querySelectorAll("#route-stops button")].find(button => button.textContent === "Down").click();
  assert.match(app.doc.querySelector("#feedback-list").textContent, /Confirmed response/);
  assert.equal(app.doc.querySelector("#feedback-list").getAttribute("aria-busy"), "false");
});
test("automatic refresh updates selected Tour details and preserves unsaved notes", async t => {
  let revision = 1;
  const app = await openBroker(() => feedbackResponse("Updated response"), {
    detailRead: data => ({ ...data, name: `Demo Tour revision ${revision}` }),
  });
  app.doc.querySelector(".tour-button").click(); await settle();
  revision = 2;
  app.dom.window.dispatchEvent(new app.dom.window.Event("online")); await settle(); await settle();
  assert.equal(app.doc.querySelector("#tour-name").textContent, "Demo Tour revision 2");
  const notes = app.doc.querySelector("#cheat-content"); notes.value = "Synthetic unsaved note";
  notes.dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
  const before = app.reads.filter(path => path === "/api/tours/detail").length;
  revision = 3;
  app.dom.window.dispatchEvent(new app.dom.window.Event("online")); await settle(); await settle();
  assert.equal(app.reads.filter(path => path === "/api/tours/detail").length, before);
  assert.equal(notes.value, "Synthetic unsaved note");
  assert.match(app.doc.querySelector("#feedback-list").textContent, /Updated response/);
});

async function openShare({ items = [], refuseOnce = false, properties = [{ property_ref: propertyRef, name: "Demo medical office" }], holdWrite = null, feedbackRead = null, permissionScopes = ["shortlist", "comment"], fastTimeout = false } = {}) {
  const dom = openDom(html, { url: "https://reports.doctorcre.com/share", runScripts: "outside-only" });
  const writes = [];
  const reads = [];
  dom.window.fetch = async (path, options = {}) => {
    if (!options.method) reads.push(path);
    let data;
    if (path === "/api/share/report") data = { items: properties };
    else if (path === "/api/share/map") data = { points: [] };
    else if (path === "/api/share/feedback") {
      if (feedbackRead) {
        const response = await feedbackRead(options);
        if (response) return response;
      }
      data = { projection_ref: "projection:public:synthetic_projection", permission_scopes: permissionScopes, ...(items === null ? {} : { items }) };
    }
    else if (path === "/api/share/shortlist" || path === "/api/share/comment") {
      writes.push({ path, ...JSON.parse(options.body) });
      if (holdWrite) await holdWrite(path);
      if (refuseOnce) { refuseOnce = false; return { ok: false, json: async () => ({ error: "unavailable" }) }; }
      data = {};
    } else throw new Error(`Unexpected share request: ${path}`);
    return { ok: true, json: async () => ({ data: structuredClone(data) }) };
  };
  if (fastTimeout) {
    const timeout = dom.window.setTimeout.bind(dom.window);
    dom.window.setTimeout = (fn, delay) => timeout(fn, delay === 15000 ? 0 : delay);
  }
  dom.window.eval(share);
  await settle();
  return { dom, doc: dom.window.document, writes, reads };
}

test("reopening a private saved shortlist offers deliberate add and remove without inventing a prior choice", async t => {
  // projectTourClientFeedback at pinned CARR 0cc6fe2538a81521bf8c25b0df58aa4063ed614b
  // returns only property_ref in each item, even when shortlisted is saved true.
  const responseItems = [{ property_ref: propertyRef }];
  const first = await openShare({ items: responseItems });
  shortlistAction(first.doc).click(); await settle();
  assert.equal(first.writes[0].shortlisted, true);

  const reopened = await openShare({ items: responseItems });
  assert.match(reopened.doc.querySelector(".shortlist-state")?.textContent || "", /Previous shortlist choices are not shown/);
  assert.equal(reopened.doc.querySelectorAll("button[aria-pressed]").length, 0);
  assert.ok(shortlistAction(reopened.doc));
  assert.ok(shortlistAction(reopened.doc, "Remove from shortlist"));
  shortlistAction(reopened.doc, "Remove from shortlist").click(); await settle();
  assert.deepEqual([...first.writes, ...reopened.writes].map(write => write.shortlisted), [true, false]);
  assert.equal(reopened.doc.querySelector(".shortlist-state").textContent, "Removed from shortlist.");
});

test("acknowledged explicit shortlist choices update only this visit's choice", async t => {
  const app = await openShare();
  const choice = () => app.doc.querySelector(".shortlist-state").textContent;
  assert.equal(choice(), "Previous shortlist choices are not shown.");
  shortlistAction(app.doc).click();
  await settle();
  assert.equal(app.doc.querySelector("#feedback-status").textContent, "Shortlist saved.");
  assert.equal(choice(), "Added to shortlist.");
  shortlistAction(app.doc, "Remove from shortlist").click();
  await settle();
  assert.equal(choice(), "Removed from shortlist.");
  assert.deepEqual(app.writes.map(write => write.shortlisted), [true, false]);
  assert.ok(app.writes.every(write => write.property_ref === propertyRef));
});

test("shortlist saves preserve unsaved comments on every property", async t => {
  const app = await openShare({ properties: [
    { property_ref: propertyRef, name: "Demo office A" },
    { property_ref: "property:public:synthetic_property_02", name: "Demo office B" },
  ] });
  const inputs = app.doc.querySelectorAll("textarea");
  inputs[0].value = "Draft for A"; inputs[1].value = "Draft for B";
  shortlistAction(app.doc).click(); await settle();
  assert.deepEqual([...app.doc.querySelectorAll("textarea")].map(input => input.value), ["Draft for A", "Draft for B"]);
  assert.equal(app.doc.querySelector(".shortlist-state").textContent, "Added to shortlist.");
});

test("saving another property's feedback retains in-flight controls and newer comment drafts", async t => {
  const held = deferred();
  const app = await openShare({ properties: [
    { property_ref: propertyRef, name: "Demo office A" },
    { property_ref: "property:public:synthetic_property_02", name: "Demo office B" },
  ], holdWrite: path => path === "/api/share/comment" ? held.promise : Promise.resolve() });
  const rows = () => app.doc.querySelectorAll(".report-item");
  const commentButton = row => [...row.querySelectorAll("button")].find(button => button.textContent === "Save comment");
  rows()[0].querySelector("textarea").value = "Submitted A comment";
  commentButton(rows()[0]).click(); await settle();
  rows()[0].querySelector("textarea").value = "Newer A draft";
  rows()[1].querySelector("textarea").value = "Unsaved B draft";
  shortlistAction(rows()[1]).click(); await settle();
  assert.equal(commentButton(rows()[0]).disabled, true);
  assert.deepEqual([...app.doc.querySelectorAll("textarea")].map(input => input.value), ["Newer A draft", "Unsaved B draft"]);
  held.resolve(); await settle();
  assert.equal(commentButton(rows()[0]).disabled, false);
  assert.match(rows()[0].querySelector(".comment-list").textContent, /Submitted A comment/);
  assert.deepEqual([...app.doc.querySelectorAll("textarea")].map(input => input.value), ["Newer A draft", "Unsaved B draft"]);
});

test("a refused shortlist save retains the unknown choice and retries the same logical write", async t => {
  const app = await openShare({ refuseOnce: true });
  const button = () => shortlistAction(app.doc);
  button().click();
  await settle();
  assert.equal(app.doc.querySelector(".shortlist-state").textContent, "Previous shortlist choices are not shown.");
  assert.equal(button().disabled, false);
  assert.match(app.doc.querySelector("#feedback-status").textContent, /could not be saved/);
  button().click();
  await settle();
  assert.equal(app.doc.querySelector(".shortlist-state").textContent, "Added to shortlist.");
  assert.equal(app.writes[0].idempotency_key, app.writes[1].idempotency_key);
});

test("a partial feedback outage is visible and retry restores scoped controls without reloading the report", async t => {
  let attempts = 0;
  const held = deferred();
  const app = await openShare({ feedbackRead: () => ++attempts === 1
    ? { ok: false, json: async () => ({ error: "unavailable" }) }
    : attempts === 2 ? held.promise : null });
  const row = app.doc.querySelector(".report-item");
  assert.match(row.textContent, /Demo medical office/);
  assert.match(app.doc.querySelector("#status").textContent, /Feedback unavailable/);
  assert.match(app.doc.querySelector("#feedback-status").textContent, /unavailable/);
  const retry = [...app.doc.querySelectorAll("button")].find(button => button.textContent === "Retry feedback");
  assert.ok(retry && !retry.hidden && !retry.disabled);
  retry.click(); await settle();
  assert.equal(retry.disabled, true);
  assert.match(app.doc.querySelector("#feedback-status").textContent, /Loading feedback/);
  retry.click(); await settle();
  assert.equal(attempts, 2);
  held.resolve({ ok: false, json: async () => ({ error: "unavailable" }) }); await settle();
  assert.match(app.doc.querySelector("#feedback-status").textContent, /unavailable/);
  assert.equal(retry.disabled, false);
  retry.click(); await settle();
  assert.equal(retry.hidden, true);
  assert.equal(app.doc.querySelector(".report-item"), row);
  assert.equal(app.doc.querySelectorAll(".feedback-controls").length, 1);
  assert.ok(shortlistAction(app.doc, "Remove from shortlist"));
  assert.ok(row.querySelector("textarea"));
  assert.equal(app.doc.querySelector("#status").textContent, "Report and map loaded.");
  assert.doesNotMatch(app.doc.querySelector("#feedback-status").textContent, /unavailable/);
  assert.equal(app.reads.filter(path => path === "/api/share/report").length, 1);
  assert.equal(app.reads.filter(path => path === "/api/share/map").length, 1);
  shortlistAction(app.doc).click(); await settle();
  assert.equal(app.writes[0].shortlisted, true);
});

test("a successful grant without feedback scopes stays read-only without an outage or retry", async t => {
  const app = await openShare({ permissionScopes: [] });
  assert.equal(app.doc.querySelectorAll(".feedback-controls").length, 0);
  assert.equal(app.doc.querySelector("#status").textContent, "Report and map loaded.");
  assert.equal(app.doc.querySelector("#feedback-status").textContent, "");
  assert.equal([...app.doc.querySelectorAll("button")].filter(button => button.textContent === "Retry feedback" && !button.hidden).length, 0);
});

test("a first comment appears even when the feedback response omits property rows", async t => {
  const app = await openShare({ items: null });
  const input = app.doc.querySelector("textarea");
  const comment = "Demo: please check the parking.";
  input.value = comment;
  [...app.doc.querySelectorAll("button")].find(button => button.textContent === "Save comment").click();
  await settle();
  assert.equal(app.doc.querySelector(".comment-list").textContent, comment);
  assert.equal(app.writes[0].comment, comment);
  assert.equal(app.doc.querySelector("textarea").value, "");
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


test("Dot Tour: broker Refresh renders CARR data.feedback comments and shortlist", async t => {
  const app = await openBroker(() => ({ ok: true, json: async () => ({ data: { feedback: {
    items: [{ route_label: "A", shortlisted: true, comments: [{ comment: "Synthetic reviewed response" }] }],
  } } }) }));
  app.doc.querySelector(".tour-button").click(); await settle();
  app.doc.querySelector("#refresh-feedback").click(); await settle();
  assert.match(app.doc.querySelector("#feedback-list").textContent, /Synthetic reviewed response/);
  assert.match(app.doc.querySelector("#feedback-list").textContent, /Shortlisted/);
  assert.equal(app.doc.querySelector("#feedback-empty").hidden, true);
});


for (const stalled of ["fetch", "body"]) test(`Dot Tour: stalled feedback ${stalled} times out without hiding the report and can retry`, async t => {
  const signals = []; let hang = true;
  const app = await openShare({ fastTimeout: true, feedbackRead: options => {
    signals.push(options.signal);
    if (!hang) return null;
    return stalled === "fetch" ? new Promise(() => {}) : { ok: true, json: () => new Promise(() => {}) };
  } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.doc.querySelectorAll(".report-item").length, 1);
  assert.match(app.doc.querySelector("#status").textContent, /Report and map loaded.*Feedback unavailable/);
  assert.equal(signals[0]?.aborted, true);
  const retry = [...app.doc.querySelectorAll("button")].find(button => button.textContent === "Retry feedback");
  assert.equal(retry.hidden, false);
  retry.click(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(retry.disabled, false); assert.equal(signals[1]?.aborted, true);
  hang = false; retry.click(); await settle();
  assert.equal(retry.hidden, true); assert.ok(shortlistAction(app.doc));
  assert.equal(app.doc.querySelectorAll(".report-item").length, 1);
});
