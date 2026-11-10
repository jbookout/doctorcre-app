import { fileURLToPath } from "node:url";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { detail, workspace } from "./leads-workspace-fixture.mjs";

export async function historyFixture(recording: unknown, registry: unknown, signal: AbortSignal) {
  const assets = await appAssetSnapshot(undefined, fileURLToPath(new URL("../", import.meta.url)));
  signal.throwIfAborted();
  return startWorkerFixture({
    assets,
    signal,
    env: {
      APP_ENV: "fixture",
      CARR: {
        fetch: async (request) => {
          if (new URL(request.url).pathname !== "/mcp")
            return Response.json({
              actor: { slug: "example-partner" },
              csrf_token: "synthetic-test-token",
              items: [],
              counts: {},
            });
          const body = await request.json();
          const params = body.params;
          let value: unknown;
          if (params?.name === "list-verbs") value = registry;
          else if (params?.name === "quiet-follow-ups") value = recording;
          else if (params?.name === "lead-board") {
            const board = workspace();
            if (params.arguments?.lead_id)
              board.detail = detail(board.leads.find((row) => row.id === params.arguments.lead_id));
            value = board;
          } else
            return Response.json({
              result: { isError: true, content: [{ type: "text", text: '{"error":"fixture_read_unavailable"}' }] },
            });
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: JSON.stringify(value) }] },
          });
        },
      },
    },
  });
}
