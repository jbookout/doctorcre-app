import { validateLeadDetail, validateLeadWorkspace } from "../js/leads-client.js";
import { parseOpportunityTiming } from "../src/ui/lead-opportunity-timing.ts";
import { detail, emptyQuietFollowUps, lead } from "./leads-workspace-fixture.mjs";
export const unknownTiming = {
  contract: "lead-opportunity-timing.v1",
  record_added_at: "2026-11-01T02:30:00Z",
  status: "unknown",
  events: [],
};
export const supportedTiming = {
  ...unknownTiming,
  status: "supported",
  events: [
    {
      date: "2026-10-01",
      date_type: "date",
      date_basis: "enumeration",
      source: "nppes",
      record_key: "synthetic-npi",
      revision: "1",
      source_url: "https://example.test/nppes",
      published_on: "2026-11-01",
      observed_at: "2026-11-02T02:30:00Z",
      meaning: "NPI enumerated",
      uncertainty: "Practice opening and real-estate decision unverified",
    },
  ],
};
export function timingFixture() {
  let timing = structuredClone(supportedTiming);
  return {
    revise() {
      timing.events = timing.events.map((event) => ({ ...event, date: "2026-10-02", revision: "2" }));
    },
    withdraw() {
      timing = { ...unknownTiming, events: [] };
    },
    restore() {
      timing = structuredClone(supportedTiming);
    },
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (path === "/mcp") {
        const p = (await request.json()).params;
        let payload: unknown;
        if (p.name === "lead-board") {
          const board = validateLeadWorkspace(
            {
              schema_version: "lead-workspace.v1",
              generated_at: "2026-11-02T12:00:00Z",
              leads: [
                lead(1, { opportunity_timing: timing }),
                lead(2, {
                  opportunity_timing: unknownTiming,
                  updated_at: "2026-12-01T12:00:00Z",
                  last_stage_move: { automatic: true, reason: "Reply received", occurred_at: "2026-11-02T12:00:00Z" },
                }),
              ],
            },
            parseOpportunityTiming,
          );
          payload = {
            ...board,
            ...(p.arguments.lead_id
              ? {
                  detail: validateLeadDetail(
                    detail(board.leads.find((r: { id: string }) => r.id === p.arguments.lead_id)),
                    p.arguments.lead_id,
                    parseOpportunityTiming,
                  ),
                }
              : {}),
          };
        } else if (p.name === "quiet-follow-ups") payload = emptyQuietFollowUps();
        else if (p.name === "list-practice-origination")
          payload = {
            contract: "practice-origination.v1",
            cards: [],
            coverage: [],
            next_cursor: null,
            outreach_started: false,
          };
        else
          return Response.json({
            result: { isError: true, content: [{ type: "text", text: '{"error":"fixture_unavailable"}' }] },
          });
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
        });
      }
      if (path === "/auth/session" || path.startsWith("/api/"))
        return Response.json({ actor: { slug: "example-partner" }, csrf_token: "synthetic", items: [], counts: {} });
      return new Response("Synthetic auth gate");
    },
  };
}
