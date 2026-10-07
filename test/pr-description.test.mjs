import assert from "node:assert/strict";
import test from "node:test";
import { hasDescription } from "../scripts/check-pr-description.mjs";

test("PR description check refuses blank and untouched template bodies", () => {
  assert.equal(hasDescription(""), false);
  assert.equal(hasDescription("## What changed\n<!-- Describe the change. -->\n\n"
    + "## How verified\n<!-- Name the checks you ran. -->"), false);
  assert.equal(hasDescription("## What changed\nThe board shows model and effort on cards."), true);
});
