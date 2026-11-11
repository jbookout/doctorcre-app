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
  for (const name of [
    "feedback",
    "feedbackDownload",
    "feedbackReadOnly",
    "feedbackSaved",
    "missingScope",
    "expired",
    "revoked",
  ]) {
    const feedbackHandler = createReportsWebHandler({
      readFeedbackFn: async ({ sessionDigest }: { sessionDigest: string }) => {
        const result = await access.readFeedback(
          { query: async () => ({ rows: [{ feedback: recorded.inputs[name] }] }) },
          { session_digest: sessionDigest },
        );
        return { ok: true, data: result.feedback };
      },
    });
    const response = await feedbackHandler.fetch(
      new Request("https://reports.doctorcre.com/api/share/feedback", {
        headers: { cookie: "__Host-tour_share_session=" + "a".repeat(43) },
      }),
    );
    const actual = { status: response.status, body: await response.json() };
    if (process.env.RECORD_CLIENT_LINKS_CONTRACT === "1") recorded.responses[name] = actual;
    assert.deepEqual(actual, recorded.responses[name]);
  }
  if (process.env.RECORD_CLIENT_LINKS_CONTRACT === "1")
    await writeFile(
      new URL("./fixtures/client-links/producer.json", import.meta.url),
      `${JSON.stringify(recorded, null, 2)}\n`,
    );
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

test("test fixtures never hand-set the producer download capability", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { parse } = await import("@babel/parser");
  const violations: string[] = [];
  for (const name of await readdir(new URL("./", import.meta.url), { recursive: true })) {
    if (!/\.(?:mjs|[cm]?tsx?)$/.test(name)) continue;
    const source = parse(await readFile(new URL(name, import.meta.url), "utf8"), {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    });
    function visit(node: unknown) {
      if (!node || typeof node !== "object") return;
      if ("type" in node && node.type === "ObjectProperty" && "key" in node) {
        const key = node.key;
        if (
          key &&
          typeof key === "object" &&
          (("name" in key && key.name === "can_download") || ("value" in key && key.value === "can_download"))
        )
          violations.push(name);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    }
    visit(source);
  }
  assert.deepEqual(violations, [], "Replay recorded producer responses instead of choosing can_download in a fixture");
});
