import assert from "node:assert/strict";
import test from "node:test";

import { uploadedVersionId } from "../scripts/provider-version.mjs";

test("staging promotion uses one exact provider version ID", () => {
  assert.equal(uploadedVersionId("Worker Version ID: B9122521-99A1-42F5-BCC5-6D78B4B89DD3\n"),
    "b9122521-99a1-42f5-bcc5-6d78b4b89dd3");
  assert.throws(() => uploadedVersionId("upload complete"), /no unique Worker Version ID/);
  assert.throws(() => uploadedVersionId("Worker Version ID: 11111111-1111-4111-8111-111111111111\nWorker Version ID: 22222222-2222-4222-8222-222222222222"), /no unique Worker Version ID/);
});
