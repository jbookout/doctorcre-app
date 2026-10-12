import { mountDocPresence } from "./doc-presence.js";
import { slices } from "./slices.generated.js";
import { mountAppLayout } from "./app-layout.js";
import { mountPrefs } from "./shell.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountAutoRefresh } from "./auto-refresh.mjs";
import { offlineTourSession } from "./offline-tour-session.js";
export { navigationItems, activeDestination, appOriginForReport, appShellMarkup } from "./navigation.js";
import { mountNavigation, appOriginForReport } from "./navigation.js";

export function mountAppShell(root = document, pathname = globalThis.location?.pathname || "/") {
  const location = globalThis.location;
  const host = mountNavigation(root, pathname, { location });
  if (!host) return;
  const base = appOriginForReport(location?.origin || "");
  if (!base) mountAccount(root, host, pathname);
  if (!base && pathname !== "/share") {
    mountAppLayout(root, host, pathname, slices);
    root.querySelector(".app-layout-status").append(host.querySelector(".app-shell-call-availability"));
    mountDocPresence({ document:root, window:root.defaultView });
  }
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
    import("./global-call-mode.js").then(async ({ mountGlobalCallMode }) => {
      const call = await mountGlobalCallMode(root);
      host.querySelector("#callModeButton").onclick = () => call.open();
      root.querySelector("#callModeRetry").onclick = (event) => call.handleClick(event.target);
    });
  }
}

if (typeof document !== "undefined") mountAppShell();
