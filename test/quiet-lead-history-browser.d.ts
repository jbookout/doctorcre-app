declare const Quiet: typeof import("../src/ui/quiet-leads.tsx");
declare const view: ReturnType<typeof Quiet.mountQuietLeads>;
declare const snapshot: ReturnType<typeof import("../js/leads-client.d.ts").validateQuietFollowUps>;
interface Window {
  view: typeof view;
  snapshot: typeof snapshot;
}
