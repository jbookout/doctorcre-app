// One navigation source for every DoctorCRE route. Page scripts own their local
// controls; this component owns only the app-wide destinations and phone menu.
export const navigationItems = Object.freeze([
  { label: "Home", href: "/" },
  { label: "Leads", href: "/leads" },
  { label: "Tours", href: "/tours" },
  { label: "Deals", href: "/deals" },
  { label: "People", href: "/clients" },
  { label: "Work", href: "/tasks" },
  { label: "Control Room", href: "/control-room" },
  { label: "Updates", href: "/updates", group: "Updates" },
  { label: "Doc Chats", href: "/doc-chats", group: "Updates" },
  { label: "Work Requests", href: "/work-requests", group: "Operations" },
  { label: "All Work", href: "/all-work", group: "Operations" },
  { label: "Incidents", href: "/incidents", group: "Operations" },
  { label: "Agent Room", href: "/agent-room", group: "Operations" },
  { label: "Design Lab", href: "/design-lab", group: "Reference" },
  { label: "Status", href: "/status", group: "Reference" },
]);

const sectionForRoute = {
  "/vendors": "/clients", "/calendar": "/tasks", "/ideas-events": "/tasks",
  "/share": "/tours", "/workspace": "/", "/pipeline": "/deals",
  "/business": "/", "/progress-board": "/control-room", "/queue.html": "/control-room",
  "/control-room/progress": "/control-room", "/control-room/agents/queue": "/control-room",
  "/ideas": "/tasks", "/system-work.html": "/work-requests", "/room.html": "/agent-room",
  "/work-inventory": "/all-work", "/design": "/design-lab",
  "/design/business": "/design-lab", "/design/operations": "/design-lab",
  "/notifications": "/updates", "/conversations": "/doc-chats",
};

export function activeDestination(pathname) {
  return sectionForRoute[pathname] || pathname;
}

export function appOriginForReport(origin) {
  try {
    const url = new URL(origin);
    if (!url.hostname.startsWith("reports.")) return "";
    url.hostname = `app.${url.hostname.slice("reports.".length)}`;
    return url.origin;
  } catch { return ""; }
}

function link({ label, href }, current, base) {
  const active = href === current;
  const badge = label === "Updates" ? '<span class="nav-badge" id="navUnreadBadge" hidden></span>' : "";
  return `<a data-app-nav-item aria-label="${label}" href="${base}${href}"${active ? ' aria-current="page"' : ""}>${label}${badge}</a>`;
}

export function appShellMarkup(pathname, base = "") {
  const current = activeDestination(pathname);
  const primary = navigationItems.slice(0, 7).map((item) => link(item, current, base)).join("");
  const more = ["Updates", "Operations", "Reference"].map((group) =>
    `<div class="app-shell-more-section"><span class="app-shell-more-group">${group}</span>${navigationItems.filter((item) => item.group === group).map((item) => link(item, current, base)).join("")}</div>`).join("");
  const moreActive = navigationItems.slice(7).some((item) => item.href === current);
  return `<header class="app-shell-header">
    <a class="app-shell-brand" href="${base}/" aria-label="DoctorCRE Home">
      <svg viewBox="0 0 42 42" role="img" aria-label="Work flows from leads through deals to delivery">
        <path class="app-shell-flow" d="M7 21h9l6-9h9M16 21l6 9h9"/>
        <circle cx="7" cy="21" r="3"/><circle cx="22" cy="12" r="3"/><circle cx="31" cy="12" r="3"/><circle cx="22" cy="30" r="3"/><circle cx="31" cy="30" r="3"/>
      </svg><span>Doctor<span class="app-shell-brand-accent">CRE</span></span>
    </a>
    <details class="app-shell-menu"><summary aria-label="Navigation menu"><span class="app-shell-menu-label">Menu</span><span class="app-shell-menu-icon" aria-hidden="true"></span></summary>
      <nav class="app-shell-navigation" aria-label="Primary navigation">${primary}<div class="app-shell-more"><button type="button" class="app-shell-more-toggle${moreActive ? " app-shell-more-current" : ""}" aria-expanded="false">More</button><div class="app-shell-more-list" hidden>${more}</div></div></nav>
    </details>
    <a class="app-shell-search" href="${base}/search" aria-label="Search" title="Search"${pathname === "/search" ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg></a>
    <span class="app-shell-live" aria-hidden="true"></span>
  </header><a class="app-shell-doc" href="${base}/doc-chats" aria-label="Doc" title="Open Doc chats"><span aria-hidden="true">◍</span></a>`;
}

const localSections = Object.freeze({
  "/clients": [["Clients", "/clients"], ["Vendors", "/vendors"]],
  "/vendors": [["Clients", "/clients"], ["Vendors", "/vendors"]],
  "/tasks": [["Tasks", "/tasks"], ["Calendar", "/calendar"], ["Ideas", "/ideas-events?tab=ideas"], ["Events", "/ideas-events?tab=events"]],
  "/calendar": [["Tasks", "/tasks"], ["Calendar", "/calendar"], ["Ideas", "/ideas-events?tab=ideas"], ["Events", "/ideas-events?tab=events"]],
  "/ideas-events": [["Tasks", "/tasks"], ["Calendar", "/calendar"], ["Ideas", "/ideas-events?tab=ideas"], ["Events", "/ideas-events?tab=events"]],
});

function mountLocalSections(root, pathname, base) {
  const items = localSections[pathname];
  const title = root.querySelector("main h1");
  if (!items || !title) return;
  const tabs = root.createElement("nav");
  tabs.className = "app-section-tabs";
  tabs.setAttribute("aria-label", `${pathname === "/clients" || pathname === "/vendors" ? "People" : "Work"} pages`);
  for (const [label, href] of items) {
    const anchor = root.createElement("a");
    anchor.href = `${base}${href}`;
    anchor.textContent = label;
    anchor.dataset.sectionTab = label.toLowerCase();
    tabs.append(anchor);
  }
  title.insertAdjacentElement("afterend", tabs);
  const sync = () => {
    const selected = pathname === "/ideas-events"
      ? new URLSearchParams(globalThis.location?.search || "").get("tab") === "events" ? "events" : "ideas"
      : pathname.slice(1);
    for (const anchor of tabs.querySelectorAll("a")) {
      if (anchor.dataset.sectionTab === selected) anchor.setAttribute("aria-current", "page");
      else anchor.removeAttribute("aria-current");
    }
  };
  sync();
  globalThis.window?.addEventListener?.("popstate", sync);
  if (pathname === "/ideas-events") root.getElementById("ideaTabs")?.addEventListener("click", () => setTimeout(sync, 0));
}

export function mountAppShell(root = document, pathname = globalThis.location?.pathname || "/") {
  const host = root.getElementById("appShell");
  if (!host) return;
  const base = appOriginForReport(globalThis.location?.origin || "");
  host.innerHTML = appShellMarkup(pathname, base);
  if (root.getElementById("docFab")) host.querySelector(".app-shell-doc").hidden = true;
  mountLocalSections(root, pathname, base);
  const menu = host.querySelector(".app-shell-menu");
  const moreButton = host.querySelector(".app-shell-more-toggle");
  const moreList = host.querySelector(".app-shell-more-list");
  const phone = globalThis.matchMedia?.("(max-width: 900px)");
  const setMode = () => { menu.open = !phone?.matches; moreList.hidden = !phone?.matches; moreButton.setAttribute("aria-expanded", "false"); };
  setMode();
  phone?.addEventListener?.("change", setMode);
  moreButton.addEventListener("click", () => {
    moreList.hidden = !moreList.hidden;
    moreButton.setAttribute("aria-expanded", String(!moreList.hidden));
  });
  host.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (phone?.matches && menu.open) { menu.open = false; menu.querySelector("summary").focus(); }
    else if (!moreList.hidden) { moreList.hidden = true; moreButton.setAttribute("aria-expanded", "false"); moreButton.focus(); }
  });
}

if (typeof document !== "undefined") mountAppShell();
