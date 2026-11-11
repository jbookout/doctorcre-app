import { type BrowserContext, test as base } from "@playwright/test";
import { type InboxItem, object, parseSnapshot } from "../../src/ui/home/inbox.tsx";

export const readOnlyVerbs: readonly string[] = [
  "calendar-meeting-prep",
  "capture-queue",
  "catch-me-up",
  "current-work-item",
  "current-work-requests",
  "deal-board",
  "deal-room-board",
  "email-match-contacts",
  "engineering-passport",
  "find",
  "find-and-catch-up",
  "get-call-context",
  "get-deal-room",
  "get-incident",
  "governance-queue",
  "ideal-client-profile",
  "incident-board",
  "lead-board",
  "list-deal-documents",
  "list-doc-conversations",
  "list-doc-suggestions",
  "list-email-proposals",
  "list-email-thread-filings",
  "list-fact-review",
  "list-feature-switches",
  "list-industry-events",
  "list-my-codex-sessions",
  "list-practice-origination",
  "list-progress-boards",
  "list-verbs",
  "loop-board",
  "loop-headers",
  "morning-assurance-queue",
  "morning-brief",
  "morning-brief-queue",
  "notification-feed",
  "preview-email-deal-progress",
  "preview-email-filing",
  "preview-email-next-step",
  "quiet-follow-ups",
  "read-actor-roster-v1",
  "read-assurance-health",
  "read-call-outcomes",
  "read-deal-update-reviews",
  "read-dispatch-history",
  "read-doc-activity",
  "read-doc-conversation",
  "read-doc-outcome-cards",
  "read-home-agenda",
  "read-home-inbox",
  "read-home-inbox-v2",
  "read-home-inbox-v3",
  "read-home-inbox-v4",
  "read-home-inbox-v5",
  "read-home-review",
  "read-invoice-tracker",
  "read-loop",
  "read-notification-preferences",
  "read-portfolio",
  "read-post-call-followups",
  "read-progress-board",
  "read-resource-dashboard",
  "read-room",
  "read-room-queue",
  "read-session-identity",
  "resolve-action-link",
  "schedule-board",
  "search-parties-v1",
  "standing-context",
  "territory-state-board",
  "today-triage",
  "unfinished-work",
  "work-queue",
  "work-request-card",
];

type Admission = { items: InboxItem[]; verbs: readonly string[] };
const snapshots = new WeakMap<BrowserContext, Promise<InboxItem[]>>();
const admissions = new WeakMap<BrowserContext, Admission>();
export async function inboxItems(context: BrowserContext): Promise<InboxItem[]> {
  return snapshots.get(context) || [];
}
export function admitItems(context: BrowserContext, items: InboxItem[], verbs: readonly string[]): void {
  admissions.set(context, { items, verbs });
}
export function clearAdmission(context: BrowserContext): void {
  admissions.delete(context);
}

export const test = base.extend<{ walkPrivacy: undefined }>({
  walkPrivacy: [
    async ({ context }, use, info) => {
      if (info.project.name === "setup") return use(undefined);
      const batches = new Map<string, { verb: string; ids: string[] }>();
      context.on("response", (response) => {
        const request = response.request();
        if (
          new URL(response.url()).pathname === "/mcp" &&
          request.method() === "POST" &&
          /^read-home-inbox-v[2-5]$/.test(request.postDataJSON()?.params?.name || "")
        ) {
          snapshots.set(
            context,
            response
              .json()
              .then((envelope) => {
                if (!response.ok() || envelope.result?.isError) return [];
                const value = JSON.parse(
                  envelope.result.content.find((entry: { type: string }) => entry.type === "text").text,
                );
                return parseSnapshot(value).items;
              })
              .catch(() => []),
          );
        }
        if (response.status() >= 400) {
          info.annotations.push({
            type: "http-status",
            description: `${response.request().resourceType()} ${response.status()}`,
          });
        }
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.continue();
        const path = new URL(request.url()).pathname;
        if (path === "/mcp" && request.method() === "POST") {
          let params: unknown;
          try {
            const envelope = request.postDataJSON();
            if (envelope?.method !== "tools/call") return route.abort("blockedbyclient");
            params = envelope.params;
          } catch {
            return route.abort("blockedbyclient");
          }
          if (!object(params)) return route.abort("blockedbyclient");
          const name = params.name;
          if (typeof name === "string" && readOnlyVerbs.includes(name)) return route.continue();
          const admission = admissions.get(context);
          const args = params.arguments;
          if (
            admission &&
            typeof name === "string" &&
            admission.verbs.includes(name) &&
            object(args) &&
            typeof args.idempotency_key === "string"
          ) {
            const current = await inboxItems(context);
            const owned = admission.items.filter((item) =>
              current.some(
                (row) =>
                  row.item_id === item.item_id && row.deal_id === item.deal_id && row.action_id === item.action_id,
              ),
            );
            const batch = typeof args.undo_of === "string" ? batches.get(args.undo_of) : undefined;
            const ids = ["set-home-waiting", "clear-home-waiting"].includes(name)
              ? [args.item_id]
              : Array.isArray(args.items)
                ? args.items.map((item: unknown) => (object(item) ? item.item_id : null))
                : typeof args.item_id === "string"
                  ? [args.item_id]
                  : typeof args.action_id === "string"
                    ? owned.filter((item) => item.action_id === args.action_id).map((item) => item.item_id)
                    : batch?.ids || [];
            const exact =
              (args.item_id === undefined || owned.some((item) => item.item_id === args.item_id)) &&
              (args.deal_id === undefined || owned.some((item) => item.deal_id === args.deal_id)) &&
              ids.length > 0 &&
              ids.every((id: unknown) => owned.some((item) => item.item_id === id));
            const action =
              !["complete-one-action", "reopen-one-action"].includes(name) ||
              (ids.length === 1 && owned.some((item) => item.item_id === ids[0] && item.action_id === args.action_id));
            const undo =
              args.undo_of === undefined ||
              (batch?.verb === name && ids.every((id: unknown) => batch.ids.includes(String(id))));
            if (exact && action && undo) {
              if (args.reversible === true && args.undo_of === undefined)
                // Exact admission above matches every ID to a string item_id in the current snapshot.
                batches.set(args.idempotency_key, { verb: name, ids: ids as string[] });
              return route.continue();
            }
          }
        }
        // Refuse background outbox replay, email submission and unrequested app writes.
        await route.abort("blockedbyclient");
      });
      try {
        await use(undefined);
      } finally {
        for (const error of info.errors) {
          for (const key of Object.keys(error)) Reflect.deleteProperty(error, key);
          error.message = "Walk failed. Private diagnostic text suppressed.";
        }
      }
    },
    { auto: true },
  ],
});
