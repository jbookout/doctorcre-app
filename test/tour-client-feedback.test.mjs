import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const share = readFileSync(new URL("../reports/share.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../reports/share.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../reports/share.css", import.meta.url), "utf8");
const tours = readFileSync(new URL("../tours/app.js", import.meta.url), "utf8");
const tourHtml = readFileSync(new URL("../tours/index.html", import.meta.url), "utf8");

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
