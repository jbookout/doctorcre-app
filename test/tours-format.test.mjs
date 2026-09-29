// QA batch 2 — the selected Tour showed an ISO timestamp, "{}" as its notes,
// raw client-projection keys, and a bright native scrollbar in the phone
// navigation. The words live in tours/tour-format.js so they can be tested.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { cheatSheetText, factLabel, factSummary, formatTourDate, tourMetaLine } from "../tours/tour-format.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const appJs = await read("tours/app.js");
const css = await read("tours/app.css");

test("an ISO timestamp becomes a human date and time", () => {
  assert.equal(formatTourDate("2026-09-28T14:05:00Z", { timeZone: "UTC" }), "Sep 28, 2026, 2:05 PM");
  assert.doesNotMatch(formatTourDate("2026-09-28T14:05:00.000Z"), /T\d{2}:|Z$/);
});

test("a date-only value stays a calendar date with no clock", () => {
  assert.equal(formatTourDate("2026-10-03"), "Oct 3, 2026");
});

test("an unreadable date is not shown as if it were one", () => {
  assert.equal(formatTourDate(""), "");
  assert.equal(formatTourDate(null), "");
  assert.equal(formatTourDate("not a date"), "");
});

test("the tour meta line reads client, market and a formatted update time", () => {
  const line = tourMetaLine({ client_name: "Demo Dental", market: "Mobile, AL", updated_at: "2026-09-28T14:05:00Z" }, { timeZone: "UTC" });
  assert.equal(line, "Demo Dental · Mobile, AL · Updated Sep 28, 2026, 2:05 PM");
  assert.equal(tourMetaLine({ client_name: "Demo Dental" }), "Demo Dental");
});

test("empty notes are hidden, never shown as {}", () => {
  for (const empty of [undefined, null, "", "{}", {}, [], { notes: "" }]) assert.equal(cheatSheetText(empty), "", JSON.stringify(empty));
});

test("plain notes read as plain text, structured notes stay editable JSON", () => {
  assert.equal(cheatSheetText("Park behind the clinic"), "Park behind the clinic");
  assert.equal(cheatSheetText({ notes: "Park behind the clinic" }), "Park behind the clinic");
  assert.equal(cheatSheetText({ parking: "rear", gate: "4411" }), JSON.stringify({ parking: "rear", gate: "4411" }, null, 2));
});

test("client-projection keys read as plain property-fact labels", () => {
  assert.equal(factLabel("asking_economics"), "Asking rent and terms");
  assert.equal(factLabel("source_attribution"), "Source");
  assert.equal(factLabel("display.name"), "Property name");
  assert.equal(factLabel("display.address"), "Address");
  assert.equal(factLabel("available_sf"), "Available sf");
  assert.equal(factLabel("display.year_built"), "Year built");
  for (const key of ["asking_economics", "source_attribution", "display.suite_count", "parking_ratio"]) {
    assert.doesNotMatch(factLabel(key), /[_.]/, key);
  }
});

test("the fact summary lists labels, not keys, and skips the name and address already shown", () => {
  const summary = factSummary({ "display.name": "x", "display.address": "y", source_attribution: "z", asking_economics: "w" });
  assert.equal(summary, "Includes: Asking rent and terms, Source");
  assert.equal(factSummary({ "display.name": "x" }), "");
});

test("tours/app.js paints through the formatter", () => {
  assert.match(appJs, /from "\.\/tour-format\.js"/);
  assert.match(appJs, /tourMetaLine\(tour\)/);
  assert.match(appJs, /cheatSheetText\(tour\.cheat_sheet\?\.content\)/);
  assert.match(appJs, /factSummary\(facts\)/);
  assert.doesNotMatch(appJs, /tour\.updated_at\]\.filter/);
  assert.doesNotMatch(appJs, /JSON\.stringify\(tour\.cheat_sheet\?\.content \|\| \{\}/);
  assert.doesNotMatch(appJs, /Object\.keys\(facts\)\.sort\(\)\.join/);
  assert.doesNotMatch(appJs, /expires \$\{text\(grant\.expires_at/);
});

test("the Tours page uses dark scrollbars, including the phone navigation", () => {
  assert.match(css, /color-scheme\s*:\s*dark/);
  assert.match(css, /scrollbar-color\s*:/);
  assert.match(css, /\.app-shell-navigation[^{]*::-webkit-scrollbar/);
  const print = css.match(/@media\s+print\s*\{[\s\S]*$/)?.[0] || "";
  assert.match(print, /color-scheme\s*:\s*light/);
});
