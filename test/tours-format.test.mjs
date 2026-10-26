// QA batch 2 — the selected Tour showed an ISO timestamp, "{}" as its notes,
// raw client-projection keys, and a bright native scrollbar in the phone
// navigation. The words live in tours/tour-format.js so they can be tested.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { cheatSheetText, factLabel, factSummary, formatTourDate, tourMetaLine, tourDisplayName, itinerarySheetText } from "../tours/tour-format.js";

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

test("the internal itinerary keeps held and excluded stops separate from active visits", () => {
  const tour = { name: "Demo tour", routes: [
    { accepted: false, route_version: 2, stops: [{ stop_state: "held", property_name: "Unaccepted replacement" }] },
    { accepted: true, route_version: 1, stops: [
      { route_sequence: null, route_label: null, stop_state: "excluded", property_name: "Demo excluded office", property_address: "400 Example Way", appointment_start: "2026-10-26T16:00:00Z", appointment_end: "2026-10-26T16:30:00Z", dwell_minutes: 99, buffer_minutes: 15 },
      { route_sequence: 2, route_label: "B", stop_state: "active", property_name: "Demo active office", property_address: "200 Example Way", dwell_minutes: 30, buffer_minutes: 10 },
      { route_sequence: null, route_label: null, stop_state: "held", property_name: "Demo held office", property_address: "100 Example Way", access_notes: "Private access note", appointment_end: "2026-10-26T18:00:00Z" },
      { route_sequence: null, route_label: null, stop_state: "held" },
    ] },
  ] };
  const original = structuredClone(tour);
  assert.equal(itinerarySheetText(tour), [
    "Internal only. Not for client distribution.", "Demo tour", "Accepted route version 1",
    "B · Demo active office\nAddress: 200 Example Way\nAppointment start: Not recorded\nAppointment end: Not recorded\nDwell: 30 minutes\nBuffer: 10 minutes",
    "Not on the active itinerary",
    "Demo excluded office\nStatus: Excluded\nAddress: 400 Example Way\nAppointment start: 2026-10-26T16:00:00Z\nAppointment end: 2026-10-26T16:30:00Z\nDwell: 99 minutes\nBuffer: 15 minutes",
    "Demo held office\nStatus: Held\nAddress: 100 Example Way\nAppointment start: Not recorded\nAppointment end: 2026-10-26T18:00:00Z\nDwell: Not recorded\nBuffer: Not recorded",
    "Not recorded\nStatus: Held\nAddress: Not recorded\nAppointment start: Not recorded\nAppointment end: Not recorded\nDwell: Not recorded\nBuffer: Not recorded",
  ].join("\n\n"));
  assert.deepEqual(tour, original);
  const route = tour.routes[1];
  route.stops = route.stops.filter(stop => stop.stop_state === "active");
  assert.doesNotMatch(itinerarySheetText(tour), /Not on the active itinerary/);
  route.stops = original.routes[1].stops.filter(stop => stop.stop_state !== "active");
  assert.equal(itinerarySheetText(tour), "");
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

test("the Tours page scrollbars follow the theme, including the phone navigation", async () => {
  const tokens = await read("css/tokens.css");
  assert.match(tokens, /color-scheme\s*:\s*dark/);
  assert.match(tokens, /color-scheme\s*:\s*light/);
  assert.match(css, /scrollbar-color\s*:/);
  assert.match(css, /\.app-shell-navigation[^{]*::-webkit-scrollbar/);
  const print = css.match(/@media\s+print\s*\{[\s\S]*$/)?.[0] || "";
  assert.match(print, /color-scheme\s*:\s*light/);
});

test("tour names in lists drop record IDs so generated names read as words", () => {
  assert.equal(tourDisplayName("Synthetic staging QA fc7b047a-84a1-45c0-a1b6-df27edb6e1f5 draft tour"), "Synthetic staging QA draft tour");
  assert.equal(tourDisplayName("Demo Gulf Coast Tour"), "Demo Gulf Coast Tour");
  assert.equal(tourDisplayName("fc7b047a-84a1-45c0-a1b6-df27edb6e1f5"), "Untitled tour");
  assert.equal(tourDisplayName(null), "Untitled tour");
});
