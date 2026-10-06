import { mountDocPresence } from "./doc-presence.js";
import { slices } from "./slices.generated.js";
import { registerSlices, NAVIGATION_GROUPS } from "./slice-registration.js";
import { mountAppLayout } from "./app-layout.js";
import { mountPrefs } from "./shell.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountAutoRefresh } from "./auto-refresh.mjs";
import { offlineTourSession } from "./offline-tour-session.js";
// One navigation source for every DoctorCRE route. Page scripts own their local
// controls; this module owns the shared rail and layout.
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

export function mountAppShell(root = document, pathname = globalThis.location?.pathname || "/") {
  const host = root.getElementById("appShell");
  if (!host) return;
  const base = appOriginForReport(globalThis.location?.origin || "");
  host.innerHTML = appShellMarkup(pathname, base, globalThis.location?.search || "");
  if (base) host.querySelector(".app-shell-controls").remove();
  else mountAccount(root, host, pathname);
  if (!base && pathname !== "/share") { mountAppLayout(root, host, pathname, slices); mountDocPresence({ document:root, window:root.defaultView }); }
  else root.body.classList.add("report-shell");
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
}



export function partnerIdentity(session) {
  const slug = session?.actor?.slug;
  return slug === "joe" || slug === "dell" ? { slug, name: slug === "joe" ? "Joe" : "Dell", initial: slug === "joe" ? "J" : "D" } : null;
}

function mountAccount(root, host, pathname) {
  mountPrefs();
  const avatar = host.querySelector("#selfAvatar");
  const panel = host.querySelector("#accountMenu");
  root.body.append(panel);
  let session = null;
  const showPartner = (identity) => {
    if (!identity) return;
    const title = `${identity.name}'s Workspace`;
    avatar.textContent = identity.initial;
    avatar.setAttribute("aria-label", `${identity.name}: account and settings`);
    panel.querySelector("#accountWorkspace").textContent = title;
    const workspace = root.getElementById("viewerWorkspace");
    if (workspace) workspace.textContent = title;
    panel.querySelector("#accountProfile").onclick = () => {
      const dialog = root.createElement("dialog");
      dialog.className = "app-shell-profile";
      dialog.innerHTML = `<header><h2>Profile</h2><button type="button" aria-label="Close profile">×</button></header><div class="app-shell-profile-identity"><span>${identity.initial}</span><h3>${identity.name}</h3></div>`;
      root.body.append(dialog);
      dialog.querySelector("button").onclick = () => dialog.close();
      dialog.addEventListener("close", () => { dialog.remove(); avatar.focus(); });
      close(); dialog.showModal();
    };
  };
  const close = () => { panel.hidden = true; avatar.setAttribute("aria-expanded", "false"); };
  avatar.onclick = () => { panel.hidden = !panel.hidden; avatar.setAttribute("aria-expanded", String(!panel.hidden)); };
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || panel.hidden) return;
    const options = [...panel.querySelectorAll("button:not(:disabled), a[href]")];
    const focused = root.activeElement;
    if (focused === avatar && !event.shiftKey) { event.preventDefault(); options[0]?.focus(); }
    else if ((focused === options[0] && event.shiftKey) || (focused === options.at(-1) && !event.shiftKey)) {
      event.preventDefault(); close(); avatar.focus();
    }
  });
  panel.querySelector("#accountTheme").onclick = () => host.querySelector('[data-pref="theme"]').click();
  root.addEventListener("click", (event) => { if (!panel.contains(event.target) && !avatar.contains(event.target)) close(); });
  root.addEventListener("keydown", (event) => { if (event.key === "Escape" && !panel.hidden) { close(); avatar.focus(); } });
  const assist = host.querySelector("#colorAssistButton");
  const applyAssist = (enabled) => { root.body.classList.toggle("color-assist", enabled); root.documentElement.dataset.colorAssist = enabled ? "on" : "off"; assist.setAttribute("aria-pressed", String(enabled)); };
  try { applyAssist(localStorage.getItem("dealroom-color-assist") === "on"); } catch { applyAssist(false); }
  assist.onclick = () => { const enabled = !root.body.classList.contains("color-assist"); applyAssist(enabled); try { localStorage.setItem("dealroom-color-assist", enabled ? "on" : "off"); } catch {} };
  const boot = resolveDealroomBoot(globalThis.location);
  const readIdentity = async () => {
    try {
      if (boot.mode === "fixture") session = { actor: { slug: boot.options.selfActor === "dell" ? "dell" : "joe" } };
      else {
        const response = await fetch("/api/system-work/session", { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
        if (!response.ok) return;
        session = await response.json();
      }
      showPartner(partnerIdentity(session));
    } catch { /* retain the last authenticated identity during a connection loss */ }
  };
  readIdentity();
  mountAutoRefresh({ document: root, window: globalThis.window, refresh: readIdentity, intervalMs: 60_000 });
  panel.querySelector("#accountSignOut").onclick = async (event) => {
    if (boot.mode === "fixture") { panel.querySelector("#accountStatus").textContent = "Demo account"; return; }
    if (!session?.csrf_token) { panel.querySelector("#accountStatus").textContent = "Sign-in unavailable"; return; }
    event.target.disabled = true;
    try {
      const response = await fetch("/auth/signout", { method: "POST", credentials: "same-origin", headers: { "x-carr-csrf": session.csrf_token } });
      if (!response.ok) throw new Error();
      offlineTourSession(globalThis.window).revoke();
      globalThis.location.assign("/auth/login");
    } catch { panel.querySelector("#accountStatus").textContent = "Sign-out unavailable"; event.target.disabled = false; }
  };
  if (!root.getElementById("callModeDialog")) {
    let opening = false;
    host.querySelector("#callModeButton").onclick = async () => {
      if (opening) return;
      opening = true;
      try { const { mountGlobalCallMode } = await import("./global-call-mode.js"); const call = await mountGlobalCallMode(root); await call.open(); }
      finally { opening = false; }
    };
  }
}

if (typeof document !== "undefined") mountAppShell();
