export const routeEntries = [
  ["/","workspace.html","/"],
  ["/all-work","work-inventory.html","/work-inventory"],
  ["/calendar","calendar.html","/business"],
  ["/calls","calls.html","/business"],
  ["/client-portal","client-portal.html","/business"],
  ["/clients","business.html","/clients"],
  ["/control-room","control-room.html","/control-room"],
  ["/control-room/observatory","observatory.html","/control-room"],
  ["/control-room/progress","progress-board.html","/control-room"],
  ["/control-room/progress/board/:boardId","progress-board.html","/control-room"],
  ["/control-room/progress/work","progress-work.html","/control-room"],
  ["/deals","pipeline.html","/deals"],
  ["/design-lab","design.html","/control-room"],
  ["/doc-activity","activity.html","/control-room"],
  ["/doc-chats","conversations.html","/conversations"],
  ["/doc-chats/work","tasks.html","/tasks"],
  ["/ideas-events","ideas.html","/control-room"],
  ["/incidents","incidents.html","/incidents"],
  ["/invoices","invoices.html","/control-room"],
  ["/leads","leads.html","/leads"],
  ["/leases","lease-radar.html","/business"],
  ["/relationships","relationships.html","/business"],
  ["/search","search.html","/business"],
  ["/share","reports/share.html","/share"],
  ["/status","status.html","/control-room"],
  ["/tours","tours/index.html","/tours"],
  ["/updates","notifications.html","/notifications"],
  ["/vendors","business.html","/vendors"],
  ["/work-requests","system-work.html","/system-work.html"],
];
export const routeContract = {
  schema: "doctorcre-app-routes.v1",
  version: "1.24.0",
  routes: Object.fromEntries(routeEntries.map(([path, asset]) => [path, asset])),
  redirects: {
  "/control-room/automations": "/control-room?tab=automations",
  "/automations.html": "/control-room?tab=automations",
  "/progress-board": "/control-room/progress/board/carr-v5",
  "/workspace": "/",
  "/queue.html": "/control-room/progress/work?view=tasks",
  "/control-room/agents/queue": "/control-room/progress/work?view=tasks",
  "/pipeline": "/deals?view=board",
  "/business": "/",
  "/system-work.html": "/work-requests",
  "/room.html": "/control-room/progress/work?view=wire",
  "/agent-room": "/control-room/progress/work?view=wire",
  "/design": "/design-lab",
  "/design/business": "/design-lab?reference=business",
  "/design/operations": "/design-lab?reference=operations",
  "/work-inventory": "/all-work",
  "/notifications": "/updates",
  "/conversations": "/doc-chats",
  "/ideas": "/ideas-events",
  "/tasks": "/",
  "/work": "/",
  "/tasks.html": "/"
},
  gatePaths: Object.fromEntries(routeEntries.map(([path, , gate]) => [path, gate])),
};
export const NAVIGATION_GROUPS = ["Workspace", "Updates", "Operations", "Reference"];
export const navigationItems = [
  {
    "label": "Home",
    "href": "/"
  },
  {
    "label": "Leads",
    "href": "/leads"
  },
  {
    "label": "Tours",
    "href": "/tours"
  },
  {
    "label": "Local Deals",
    "href": "/deals"
  },
  {
    "label": "Vendors",
    "href": "/vendors"
  },
  {
    "label": "Control Room",
    "href": "/control-room"
  },
  { label: "Phone capture", href: "/calls", group: "Workspace" },
  {
    "label": "Relationships",
    "href": "/relationships",
    "group": "Workspace"
  },
  {
    "label": "Invoices",
    "href": "/invoices",
    "group": "Workspace"
  },
  {
    "label": "Clients",
    "href": "/clients",
    "group": "Workspace"
  },
  {
    "label": "Ideas",
    "href": "/ideas-events?tab=ideas",
    "group": "Workspace"
  },
  {
    "label": "Lease radar",
    "href": "/leases",
    "group": "Workspace"
  },
  {
    "label": "Events",
    "href": "/ideas-events?tab=events",
    "group": "Workspace"
  },
  {
    "label": "Updates",
    "href": "/updates",
    "group": "Updates"
  },
  {
    "label": "Doc Chats",
    "href": "/doc-chats",
    "group": "Updates"
  },
  {
    "label": "System Job Board",
    "href": "/control-room/progress",
    "group": "Operations"
  },
  {
    "label": "Work Requests",
    "href": "/work-requests",
    "group": "Operations"
  },
  {
    "label": "All Work",
    "href": "/all-work",
    "group": "Operations"
  },
  {
    "label": "Incidents",
    "href": "/incidents",
    "group": "Operations"
  },
  {
    "label": "Project activity",
    "href": "/control-room/progress/work",
    "group": "Operations"
  },
  {
    "label": "Observatory",
    "href": "/control-room/observatory",
    "group": "Operations"
  },
  {
    "label": "Design Lab",
    "href": "/design-lab",
    "group": "Reference"
  },
  {
    "label": "Status",
    "href": "/status",
    "group": "Reference"
  }
];
export const sectionForRoute = {
  "/work-inventory": "/all-work",
  "/control-room/progress": "/control-room",
  "/control-room/automations": "/control-room",
  "/control-room/observatory": "/control-room",
  "/pipeline": "/deals",
  "/design": "/design-lab",
  "/design/business": "/design-lab",
  "/design/operations": "/design-lab",
  "/doc-chats/work": "/doc-chats",
  "/conversations": "/doc-chats",
  "/tasks": "/",
  "/work": "/",
  "/workspace": "/",
  "/business": "/",
  "/ideas": "/ideas-events?tab=ideas",
  "/queue.html": "/control-room/progress/work",
  "/control-room/agents/queue": "/control-room/progress/work",
  "/agent-room": "/control-room/progress/work",
  "/room.html": "/control-room/progress/work",
  "/progress-board": "/control-room/progress/board/carr-v5",
  "/tours/day.html": "/tours",
  "/share": "/tours",
  "/notifications": "/updates",
  "/system-work.html": "/work-requests"
};
