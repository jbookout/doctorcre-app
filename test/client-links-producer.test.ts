import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("client-link response recordings match the exact CARR production projectors", {
  skip:
    !process.env.CARR_CLIENT_LINKS_PRODUCER_CHECKOUT && "Set CARR_CLIENT_LINKS_PRODUCER_CHECKOUT to verify recordings",
}, async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const recorded = JSON.parse(
    await readFile(new URL("./fixtures/client-links/producer.json", import.meta.url), "utf8"),
  );
  const root = process.env.CARR_CLIENT_LINKS_PRODUCER_CHECKOUT;
  assert.ok(root);
  assert.equal(
    execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    recorded.source_commit,
  );
  execFileSync("git", ["-C", root, "diff", "--quiet", "HEAD", "--", "mcp-server/src"]);
  const producer = await import(pathToFileURL(root + "/mcp-server/src/tour-sharing.js").href);
  if (process.env.RECORD_CLIENT_LINKS_CONTRACT === "1") {
    for (const name of ["packet", "nearMiss"])
      recorded.responses[name] = producer.projectTourClientPacket(recorded.inputs[name]);
    for (const name of ["active", "viewOnly"])
      recorded.responses[name] = producer.projectTourClientFeedback(recorded.inputs[name]);
    await writeFile(
      new URL("./fixtures/client-links/producer.json", import.meta.url),
      `${JSON.stringify(recorded, null, 2)}\n`,
    );
  }
  for (const name of ["packet", "nearMiss"])
    assert.deepEqual(producer.projectTourClientPacket(recorded.inputs[name]), recorded.responses[name]);
  for (const name of ["active", "viewOnly"])
    assert.deepEqual(producer.projectTourClientFeedback(recorded.inputs[name]), recorded.responses[name]);
  const { createReportsWebHandler } = await import(pathToFileURL(root + "/mcp-server/src/reports-web.ts").href);
  const access = producer.tourSharingBrowserAccess({ ToolError: Error });
  const handler = createReportsWebHandler({
    exchangeShareTokenFn: (input: unknown) => {
      assert.ok(
        input &&
          typeof input === "object" &&
          "tokenDigest" in input &&
          typeof input.tokenDigest === "string" &&
          "sessionDigest" in input &&
          typeof input.sessionDigest === "string" &&
          "sessionExpiresAt" in input &&
          typeof input.sessionExpiresAt === "string" &&
          "auditDigest" in input &&
          typeof input.auditDigest === "string",
      );
      return access.exchange(
        {
          query: async () => ({
            rows: [{ exchange: { permission_scopes: recorded.inputs.active.permission_scopes } }],
          }),
        },
        {
          token_digest: input.tokenDigest,
          session_digest: input.sessionDigest,
          session_expires_at: input.sessionExpiresAt,
          audit_digest: input.auditDigest,
        },
      );
    },
  });
  const origin = "https://reports.doctorcre.com";
  const exchangeRequest = () =>
    new Request(origin + "/api/share/exchange", {
      method: "POST",
      headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ token: "a".repeat(43) }),
    });
  const accepted = await handler.fetch(exchangeRequest());
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), recorded.responses.exchange);
  const refused = createReportsWebHandler({ exchangeShareTokenFn: async () => ({ status: 403 }) });
  const denied = await refused.fetch(exchangeRequest());
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), recorded.responses.exchangeRefused);
  const missingMap = await handler.fetch(
    new Request(origin + "/api/share/map", {
      headers: { cookie: "__Host-tour_share_session=" + "a".repeat(43) },
    }),
  );
  assert.equal(missingMap.status, 404);
  assert.deepEqual(await missingMap.json(), recorded.responses.mapUnavailable);
});
