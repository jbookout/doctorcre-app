import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fixturePath } from "./tour-stop-drag-proof-fixture.ts";

test("drag fixture assets stay inside their root including encoded traversal", () => {
  assert.equal(fixturePath("/tours/app.js"), path.resolve("tours/app.js"));
  for (const name of [
    "/../secret",
    "/%2e%2e/secret",
    "/%2e%2e%2fsecret",
    "/../wr591-s21-j3-other/file",
    "/",
    "/%5c..%5csecret",
  ])
    assert.throws(() => fixturePath(name), /outside root/);
});

test("drag fixture HTTP descriptors refuse encoded traversal", async () => {
  const { startFixture } = await import("../scripts/fixture-http.mjs");
  const server = await startFixture({
    routes: new Map([["/tours/app.js", { body: "fixture", contentType: "text/plain" }]]),
  });
  try {
    for (const name of ["/%2e%2e%2fsecret", "/%252e%252e%252fsecret", "/%5c..%5csecret"])
      assert.equal((await fetch(server.origin + name)).status, 400);
    assert.equal(await (await fetch(server.origin + "/tours/app.js")).text(), "fixture");
  } finally {
    await server.close();
  }
});
