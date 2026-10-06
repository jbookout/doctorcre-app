import { slices } from "./slices.generated.js";
import { registerSlices, NAVIGATION_GROUPS } from "./slice-registration.js";
// Shared navigation rendering and interaction; page mounting stays with each caller.
const registration = registerSlices(slices);
export const navigationItems = registration.navigationItems;
const sectionForRoute = registration.sectionForRoute;

export function activeDestination(pathname) {
  if (pathname.startsWith('/control-room/progress/board/')) return '/control-room/progress';
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

function groupIcon(label) {
  return { Home: "⌂", Leads: "◎", Tours: "◇", "Local Deals": "▦", Vendors: "♧", "Control Room": "◈" }[label] || "";
}

function link({ label, href }, current, base) {
  const active = href === current;
  const badge = label === "Updates" ? '<span class="nav-badge" id="navUnreadBadge" hidden></span>' : "";
  return `<a data-app-nav-item aria-label="${label}" title="${label}" href="${base}${href}"${active ? ' aria-current="page"' : ""}>${!groupIcon(label) ? label : `<span aria-hidden="true">${groupIcon(label)}</span><span class="app-shell-nav-label">${label}</span>`}${badge}</a>`;
}

export function appShellMarkup(pathname, base = "", search = "") {
  const current = pathname === "/ideas-events" ? `/ideas-events?tab=${new URLSearchParams(search).get("tab") === "events" ? "events" : "ideas"}` : activeDestination(pathname);
  const primary = navigationItems.filter(item => !item.group).map((item) => link(item, current, base)).join("");
  const more = NAVIGATION_GROUPS.map((group) =>
    `<div class="app-shell-more-section"><span class="app-shell-more-group">${group}</span>${navigationItems.filter((item) => item.group === group).map((item) => link(item, current, base)).join("")}</div>`).join("");
  const moreActive = navigationItems.filter(item => item.group).some((item) => item.href === current);
  return `<header class="app-shell-header" aria-label="Workspace rail">
    <a class="app-shell-brand" href="${base}/" aria-label="DoctorCRE Home">
      <svg viewBox="0 0 42 42" role="img" aria-label="Work flows from leads through deals to delivery">
        <path class="app-shell-flow" d="M7 21h9l6-9h9M16 21l6 9h9"/>
        <circle cx="7" cy="21" r="3"/><circle cx="22" cy="12" r="3"/><circle cx="31" cy="12" r="3"/><circle cx="22" cy="30" r="3"/><circle cx="31" cy="30" r="3"/>
      </svg><span class="app-shell-brand-name">Doctor<span class="app-shell-brand-accent">CRE</span></span>
    </a>
    <div class="app-shell-menu">
      <nav class="app-shell-navigation" aria-label="Primary navigation">${primary}<div class="app-shell-more"><button type="button" class="app-shell-more-toggle${moreActive ? " app-shell-more-current" : ""}" aria-expanded="false" aria-label="More" title="More"><span aria-hidden="true">•••</span><span class="app-shell-nav-label">More</span></button><div class="app-shell-more-list" hidden>${more}</div></div></nav>
    </div>
    <a class="app-shell-search" href="${base}/search" aria-label="Search" title="Search"${pathname === "/search" ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg></a>
    <div class="app-shell-controls" aria-label="Workspace controls">
      <button class="app-shell-control" type="button" data-pref="theme" data-on="dark" data-off="light" aria-pressed="true" aria-label="Dark mode" title="Dark mode"><span aria-hidden="true">☾</span></button>
      <button class="app-shell-control" id="callModeButton" type="button" aria-label="Call mode" title="Call mode" aria-haspopup="dialog"><span aria-hidden="true">☎</span></button>
      <button class="app-shell-control" id="colorAssistButton" type="button" aria-pressed="false" aria-label="Color assist" title="Color assist"><span aria-hidden="true">◐</span></button>
      <div class="app-shell-account"><button class="app-shell-avatar" id="selfAvatar" type="button" aria-label="Account and settings" aria-expanded="false" aria-controls="accountMenu">…</button>
        <div class="app-shell-account-menu" id="accountMenu" hidden>
          <strong id="accountWorkspace">Workspace</strong>
          <button type="button" id="accountProfile">Profile</button>
          <button type="button" id="accountTheme">Theme</button>
          <a href="${base}/updates#prefForm">Notification preferences</a>
          <a href="${base}/doc-activity"${pathname === "/doc-activity" ? ' aria-current="page"' : ""}>Doc Activity</a>
          <button type="button" id="accountSignOut">Sign out</button>
          <p id="accountStatus" role="status"></p>
        </div>
      </div>
    </div>
  </header>`;
}

// Reports mount this interface without app layout, identity reads or partner controls.
export function mountNavigation(root = document, pathname = root.defaultView?.location.pathname || "/", { report = false, location = root.defaultView?.location || globalThis.location } = {}) {
  const host = root.getElementById("appShell");
  if (!host) return;
  const base = appOriginForReport(location?.origin || "");
  host.innerHTML = appShellMarkup(pathname, base, location?.search || "");
  if (report || base) host.querySelector(".app-shell-controls").remove();
  if (report || base || pathname === "/share") root.body.classList.add("report-shell");
  const moreButton = host.querySelector(".app-shell-more-toggle");
  const moreList = host.querySelector(".app-shell-more-list");
  moreButton.addEventListener("click", () => {
    moreList.hidden = !moreList.hidden;
    moreButton.setAttribute("aria-expanded", String(!moreList.hidden));
  });
  host.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!moreList.hidden) { moreList.hidden = true; moreButton.setAttribute("aria-expanded", "false"); moreButton.focus(); }
  });
  root.addEventListener("click", (event) => {
    if (!event.target.closest(".app-shell-more") && !moreList.hidden) { moreList.hidden = true; moreButton.setAttribute("aria-expanded", "false"); }
  });
  return host;
}
