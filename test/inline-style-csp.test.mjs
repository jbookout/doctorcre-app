// src/worker.js pins the CSP to `style-src 'self' https://fonts.googleapis.com`
// — no `'unsafe-inline'` — so the browser silently drops any `style="..."`
// attribute written into markup. A template string that builds `innerHTML`
// and embeds a `style=` attribute (as the V5-UX-B04 calendar/ideas review
// caught: js/calendar.js, js/ideas.js) therefore ships motion that never
// actually applies in production, even though it renders fine locally where
// no CSP is enforced. Every per-node value that motion needs (the entrance
// stagger, in particular) has to be set through CSSOM after the paint
// instead — `node.style.setProperty(...)` — with the value handed across in
// a `data-*` attribute.
//
// This test statically scans every DOM-wiring module that paints via
// `innerHTML` for a `style=` attribute in its source. It is a source scan,
// not a DOM assertion, because this project deliberately has no jsdom
// dependency (see test/shell.test.mjs) — the same convention the worker CSP
// tests (test/dealroom-call-mode.test.mjs) already use for scanning
// src/worker.js's own text.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const STYLE_ATTR = /\bstyle\s*=\s*["'`]/;

test("no js/ module writes a style= attribute into markup (the Worker's CSP has no 'unsafe-inline')", async () => {
  const files = (await readdir(new URL("js/", ROOT))).filter((name) => name.endsWith(".js"));
  assert.ok(files.length > 0, "sanity check: js/ should list files");
  const offenders = [];
  for (const name of files) {
    const source = await read(`js/${name}`);
    if (STYLE_ATTR.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `these js/ modules write a style= attribute, which src/worker.js's CSP (style-src 'self' https://fonts.googleapis.com, no 'unsafe-inline') silently drops: ${offenders.join(", ")}`);
});
