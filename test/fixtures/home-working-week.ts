import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { appAssetSnapshot } from "../../scripts/fixture-app-assets.mjs";
import contract from "./home-working-week-contract.json" with { type: "json" };

const validate = new Ajv().compile(contract);

export function workingWeekResponses(day: string) {
  const deal = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Synthetic practice",
    short_name: "Synthetic practice",
    phase: "research",
    owner: "joe",
    type: "lease",
    attention: null,
    next_step: "Confirm synthetic work",
    next_date: day,
    last_touch: day,
    last_review_at: null,
    workspace_kind: "local",
    account_client_id: null,
    operating_state: "active",
    outcome: null,
    closed_on: null,
    invoiced_on: null,
    client_status: "active",
    prospect_engagement_status: null,
    needs_next_action: false,
    critical_dates: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        kind: "follow_up",
        due_on: day,
        note: "Synthetic deadline",
        status: "open",
      },
    ],
    next_actions: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        owner: "joe",
        description: "Confirm synthetic work",
        due_on: day,
        status: "open",
        version: 1,
        hold_until: null,
      },
    ],
    item_schema_version: "deal-items.v1",
    items: [],
  };
  const responses = {
    "read-home-agenda": { schema_version: "home-agenda.v1", actor: "joe", deals: [deal], missing_next_action: [] },
    "calendar-meeting-prep": {
      state: "partial",
      source: "outlook_local_store",
      observed_at: `${day}T15:00:00.000Z`,
      notes: ["May include meetings you declined or that were cancelled or deleted. Check Outlook."],
      sources: { outlook_calendar: { state: "partial" }, deal_suggestions: { state: "ready" } },
      match_basis: "attendee_email_possible_match",
      items: [
        {
          title: "Demo practice planning",
          start: `${day}T16:00:00.000Z`,
          end: `${day}T17:00:00.000Z`,
          location: "Synthetic office",
          organizer: { name: null, email: null },
          attendees: [],
          attendee_count: 0,
          all_day: false,
          recurring: false,
          time_changed: false,
          times: [],
          conflict: false,
          schedule_conflict: false,
          schedule_conflicts: [],
          schedule_conflicts_omitted: 0,
          possible_deals: [],
        },
      ],
    },
  };
  assert.ok(validate(responses), JSON.stringify(validate.errors));
  return responses;
}

export async function workingWeekAssets(
  day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()),
) {
  const assets = await appAssetSnapshot();
  assets.set("/data/home-working-week-responses.json", {
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(workingWeekResponses(day))),
  });
  const client = assets.get("/js/client.js");
  assert.ok(client);
  assets.set("/js/working-week-original-client.js", client);
  assets.set("/js/client.js", {
    ...client,
    body: Buffer.from(`
    export * from './working-week-original-client.js';
    import { createClient as original } from './working-week-original-client.js';
    export async function createClient(mode = 'fixture', opts = {}) {
    const fixture = await original(mode, opts);
    const { createLiveClient } = await import('./live-client.js');
    const live = createLiveClient({ docContext: false, fetchImpl: async (path, init) => {
      if (path !== '/mcp') throw Error('Unexpected working-week transport');
      const request = JSON.parse(init.body);
      const responses = await (await fetch('/data/home-working-week-responses.json')).json();
      const payload = responses[request.params.name];
      if (!payload || Object.keys(request.params.arguments).length) throw Error('Unexpected working-week read');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }));
    } });
    fixture.getHomeAgenda = live.getHomeAgenda;
    fixture.calendarMeetingPrep = live.calendarMeetingPrep;
    return fixture;
    }
  `),
  });
  return assets;
}
