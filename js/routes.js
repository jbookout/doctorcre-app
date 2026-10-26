export const routeEntries = [
  ["/","workspace.html","/"],
  ["/control-room","control-room.html","/control-room"],
  ["/control-room/progress","progress-board.html","/control-room"],
  ["/control-room/progress/board/:boardId","progress-board.html","/control-room"],
  ["/control-room/progress/work","progress-work.html","/control-room"],
  ["/deals","pipeline.html","/deals"],
  ["/leads","leads.html","/leads"],
  ["/clients","business.html","/clients"],
  ["/client-portal","client-portal.html","/business"],
  ["/vendors","business.html","/vendors"],
  ["/calendar","calendar.html","/business"],
  ["/ideas-events","ideas.html","/control-room"],
  ["/work-requests","system-work.html","/system-work.html"],
  ["/tours","tours/index.html","/tours"],
  ["/share","reports/share.html","/share"],
  ["/design-lab","design.html","/control-room"],
  ["/all-work","work-inventory.html","/work-inventory"],
  ["/search","search.html","/business"],
  ["/status","status.html","/control-room"],
  ["/incidents","incidents.html","/incidents"],
  ["/updates","notifications.html","/notifications"],
  ["/doc-chats","conversations.html","/conversations"],
  ["/doc-chats/work","tasks.html","/tasks"],
  ["/relationships","relationships.html","/business"],
  ["/doc-activity","activity.html","/control-room"],
  ["/invoices","invoices.html","/control-room"],
  ["/leases","lease-radar.html","/business"],
  ["/control-room/observatory","observatory.html","/control-room"]
];
export const routeContract = {
  schema: "doctorcre-app-routes.v1",
  version: "1.22.0",
  routes: Object.fromEntries(routeEntries.map(([path, asset]) => [path, asset])),
  redirects: {
  "/control-room/automations": "/control-room?tab=automations",
  "/automations.html": "/control-room?tab=automations",
  "/progress-board": "/control-room/progress",
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
    "label": "Local Deals",
    "href": "/deals"
  },
  {
    "label": "Tours",
    "href": "/tours"
  },
  {
    "label": "Vendors",
    "href": "/vendors",
    "group": "Workspace"
  },
  {
    "label": "Control Room",
    "href": "/control-room",
    "group": "Workspace"
  },
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
  "/progress-board": "/control-room/progress",
  "/tours/day.html": "/tours",
  "/share": "/tours",
  "/notifications": "/updates",
  "/system-work.html": "/work-requests"
};
