// Tours page primary navigation: tours/index.html must carry the same app-wide
// primary nav as its sibling pages (queue.html, system-work.html, workspace.html),
// with Tours marked as the current page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../tours/index.html", import.meta.url)), "utf8");
const css = readFileSync(fileURLToPath(new URL("../tours/app.css", import.meta.url)), "utf8");

test("tours/index.html carries a primary nav with links to Home, Leads, Deals", () => {
  const nav = html.match(/<nav class="primary-nav"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(nav, "expected a <nav class=\"primary-nav\"> block in tours/index.html");
  assert.match(nav, /href="\/"/);
  assert.match(nav, /href="\/leads"/);
  assert.match(nav, /href="\/deals"/);
});

test("the primary nav marks Tours as the active/current page", () => {
  const nav = html.match(/<nav class="primary-nav"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.match(
    nav,
    /<a[^>]*class="active"[^>]*aria-current="page"[^>]*>Tours<\/a>|<a[^>]*aria-current="page"[^>]*class="active"[^>]*>Tours<\/a>/,
  );
});

test("tours/index.html does not link the workspace app's global stylesheet", () => {
  // css/workspace.css carries global rules (dark body background, etc.) that
  // are not scoped to .primary-nav and break the tours page's own layout.
  // The dark register must be styled entirely within tours/app.css instead.
  assert.doesNotMatch(html, /href="\/css\/workspace\.css"/);
});

test("tours/app.css defines the canonical dark-register ink token and gives the body a dark background", () => {
  assert.match(css, /--ink-0\s*:\s*#[0-9a-f]{3,6}/i, "expected --ink-0 to be defined in :root");
  const bodyRule = css.match(/(?:^|\})\s*body\s*\{[^}]*\}/)?.[0] || "";
  assert.ok(bodyRule, "expected a body{...} rule in tours/app.css");
  assert.match(bodyRule, /background/, "expected the body rule to set a background");
  assert.match(bodyRule, /var\(--ink-0\)/, "expected the body background to use the dark --ink-0 token");
});

test("printing the tours page switches the colour tokens to dark-on-white", () => {
  const print = css.match(/@media\s+print\s*\{[\s\S]*$/)?.[0] || "";
  assert.ok(print, "expected an @media print block");
  for (const token of ["--text", "--muted", "--quiet", "--line"]) {
    assert.match(print, new RegExp(`${token}\\s*:\\s*#`), `print must redefine ${token}`);
  }
});

test("buttons keep the page-wide solid focus ring", () => {
  assert.doesNotMatch(css, /button:focus-visible\s*\{[^}]*rgba\(/, "button focus must not use a translucent ring");
  assert.doesNotMatch(css, /button:hover\s*,\s*button:focus-visible/, "focus must not share the hover style");
});

test("#empty-state carries no descriptive sentence under its title", () => {
  const emptyState = html.match(/<div id="empty-state"[\s\S]*?<\/div>/)?.[0] || "";
  assert.ok(emptyState, "expected an #empty-state block in tours/index.html");
  assert.doesNotMatch(emptyState, /<p>/);
});
