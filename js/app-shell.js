// One navigation source for every DoctorCRE route. Page scripts own their local
// controls; this component owns only the app-wide destinations and phone menu.
export const navigationItems = Object.freeze([
  { label: "Home", href: "/" },
  { label: "Leads", href: "/leads" },
  { label: "Tours", href: "/tours" },
  { label: "Deals", href: "/deals" },
  { label: "Clients", href: "/clients" },
  { label: "Vendors", href: "/vendors" },
  { label: "Search", href: "/business?q=" },
  { label: "Calendar", href: "/calendar" },
  { label: "Ideas", href: "/ideas" },
  { label: "Tasks", href: "/tasks" },
  { label: "Conversations", href: "/conversations" },
  { label: "Notifications", href: "/notifications" },
  { label: "System work", href: "/system-work.html" },
  { label: "Observatory", href: "/room.html" },
]);

const sectionForRoute = {
  "/workspace": "/", "/queue.html": "/room.html", "/share": "/tours",
  "/pipeline": "/deals", "/business": "/business?q=",
  "/control-room": "/system-work.html", "/progress-board": "/system-work.html",
  "/work-inventory": "/system-work.html", "/status": "/system-work.html",
  "/incidents": "/system-work.html", "/design": "/system-work.html",
  "/design/business": "/system-work.html", "/design/operations": "/system-work.html",
};

export function activeDestination(pathname) {
  return sectionForRoute[pathname] || pathname;
}

function link({ label, href }, current, base) {
  const active = href === current;
  const badge = label === "Notifications" ? '<span class="nav-badge" id="navUnreadBadge" hidden></span>' : "";
  return `<a data-app-nav-item aria-label="${label}" href="${base}${href}"${active ? ' aria-current="page"' : ""}>${label}${badge}</a>`;
}

export function appShellMarkup(pathname, base = "") {
  const current = activeDestination(pathname);
  const primary = navigationItems.slice(0, 6).map((item) => link(item, current, base)).join("");
  const more = navigationItems.slice(6).map((item) => link(item, current, base)).join("");
  const moreActive = navigationItems.slice(6).some((item) => item.href === current);
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
    <span class="app-shell-live" aria-hidden="true"></span>
  </header>`;
}

export function mountAppShell(root = document, pathname = globalThis.location?.pathname || "/") {
  const host = root.getElementById("appShell");
  if (!host) return;
  const hostName = globalThis.location?.hostname || "";
  const base = hostName === "reports.doctorcre.com" ? "https://app.doctorcre.com" : "";
  host.innerHTML = appShellMarkup(pathname, base);
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
