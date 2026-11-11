import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const STYLE_ATTR = /(?<![\w$.])style\s*=\s*["'`]/;

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


test("the CSP scan distinguishes markup attributes from object properties", () => {
  for (const value of ['<p style="color:red">', "<svg style='fill:red'>", '<div style=`color:red`>']) assert.ok(STYLE_ATTR.test(value));
  for (const value of ['font.style="oblique"', 'border.style="solid"']) assert.equal(STYLE_ATTR.test(value), false);
});
