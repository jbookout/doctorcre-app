import { privateSession } from './private-session.js';
import { mountDocPresence } from "./doc-presence.js";
import { mountAppLayout } from "./app-layout.js";
import { TOUCH_LAYOUT } from "./touch-layout.js";
import { mountPrefs } from "./shell.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountAutoRefresh } from "./auto-refresh.mjs";
import { mountNavigation, appOriginForReport } from "./navigation.js";

export function mountAppShell(root = document, pathname = globalThis.location?.pathname || "/") {
  const location = globalThis.location;
  const host = mountNavigation(root, pathname, { location });
  if (!host) return;
  const fontStylesheet = root.querySelector('link[data-font-stylesheet][rel="preload"][as="style"]');
  if (fontStylesheet) {
    const activate = () => { fontStylesheet.rel = "stylesheet"; };
    if (root.readyState === "complete") activate();
    else root.defaultView.addEventListener("load", activate, { once: true });
  }
  const base = appOriginForReport(location?.origin || "");
  let disposeDocPresence = () => {};
  if (!base) mountAccount(root, host, pathname, () => disposeDocPresence());
  if (!base && pathname !== "/share") {
    mountAppLayout(root, host, pathname);
    const status = root.querySelector(".app-layout-status");
    const availability = host.querySelector(".app-shell-call-availability");
    status.append(availability);
    const workspace = root.getElementById("accountWorkspaceControls");
    const connection = root.getElementById("appConnection");
    const controls = host.querySelector(".app-shell-controls");
    const settings = [...controls.querySelectorAll(":scope > button")];
    const search = host.querySelector(".app-shell-search");
    const refresh = status.querySelector("#appSyncRefresh");
    const freshness = refresh.parentElement;
    const phone = root.defaultView.matchMedia(TOUCH_LAYOUT);
    const arrangeControls = () => {
      workspace.hidden = !phone.matches;
      if (phone.matches) workspace.append(search, ...settings, refresh, availability, connection);
      else {
        controls.before(search);
        controls.prepend(...settings);
        freshness.append(refresh);
        status.insertBefore(connection, root.getElementById("appStatusSlot"));
        status.append(availability);
      }
    };
    phone.addEventListener("change", arrangeControls);
    arrangeControls();
    const docPresence = mountDocPresence({ document:root, window:root.defaultView });
    disposeDocPresence = () => docPresence?.dispose();
  }
}

export function partnerIdentity(session) {
  const slug = session?.actor?.slug;
  return slug === "joe" || slug === "dell" ? { slug, name: slug === "joe" ? "Joe" : "Dell", initial: slug === "joe" ? "J" : "D" } : null;
}

function mountAccount(root, host, pathname, beforeSignOutReplace = () => {}) {
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
  panel.addEventListener("click", event => {
    if (event.target.closest("#appSyncRefresh")) { close(); avatar.focus(); }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || panel.hidden) return;
    const options = [...panel.querySelectorAll("button:not(:disabled), a[href]")].filter(node => node.getClientRects().length);
    const focused = root.activeElement;
    if (focused === avatar && !event.shiftKey) { event.preventDefault(); options[0]?.focus(); }
    else if ((focused === options[0] && event.shiftKey) || (focused === options.at(-1) && !event.shiftKey)) {
      event.preventDefault(); close(); avatar.focus();
    }
  });
  panel.querySelector("#accountTheme").onclick = () => root.querySelector('[data-pref="theme"]').click();
  root.addEventListener("click", (event) => { if (!panel.contains(event.target) && !avatar.contains(event.target)) close(); });
  root.addEventListener("keydown", (event) => { if (event.key === "Escape" && !panel.hidden) { close(); avatar.focus(); } });
  const assist = host.querySelector("#colorAssistButton");
  const applyAssist = (enabled) => { root.documentElement.dataset.colorAssist = enabled ? "on" : "off"; assist.setAttribute("aria-pressed", String(enabled)); };
  try { applyAssist(localStorage.getItem("dealroom-color-assist") === "on"); } catch { applyAssist(false); }
  assist.onclick = () => { const enabled = root.documentElement.dataset.colorAssist !== "on"; applyAssist(enabled); try { localStorage.setItem("dealroom-color-assist", enabled ? "on" : "off"); } catch {} };
  const boot = resolveDealroomBoot(globalThis.location);
  const boundary = privateSession();
  globalThis.window?.addEventListener("doctorcre-session-invalidated", beforeSignOutReplace, {once:true});
  let lastVerified = null;
  const sessionStatus = root.createElement('p');
  sessionStatus.setAttribute('role','status'); sessionStatus.hidden = true;
  host.after(sessionStatus);
  const readIdentity = async () => {
    try {
      if (boot.mode === "fixture") session = { actor: { slug: boot.options.selfActor === "dell" ? "dell" : "joe" } };
      else {
        session = await boundary.verify();
        lastVerified = new Date().toLocaleTimeString(); sessionStatus.hidden = true;
        panel.querySelector("#accountStatus").textContent = "";
      }
      showPartner(partnerIdentity(session));
    } catch {
      if (!boundary?.revoked) {
        sessionStatus.textContent = lastVerified ? `Connection unavailable · Last verified ${lastVerified}` : 'Sign-in unavailable';
        sessionStatus.hidden = false;
      }
    }
  };
  readIdentity();
  mountAutoRefresh({ document: root, window: globalThis.window, refresh: readIdentity, intervalMs: 60_000 });
  panel.querySelector("#accountSignOut").onclick = async (event) => {
    if (boot.mode === "fixture") { panel.querySelector("#accountStatus").textContent = "Demo account"; return; }
    if (!session?.csrf_token) { panel.querySelector("#accountStatus").textContent = "Sign-in unavailable"; return; }
    event.target.disabled = true;
    try {
      // The auth service responds with a redirect to /. Fetch must not follow
      // that redirect into a fresh login flow before we check revocation.
      await boundary.verify();
      const response = await fetch("/auth/signout", { method: "POST", credentials: "same-origin",
        redirect: "manual", headers: { "x-carr-csrf": session.csrf_token } });
      if ([401,403].includes(response.status)) { boundary.revoke(); return; }
      if (response.type !== "opaqueredirect") throw new Error();
      const after = await fetch("/auth/session", { credentials: "same-origin", cache: "no-store",
        redirect: "manual", headers: { accept: "application/json" } });
      if (after.status !== 401) throw new Error();
      session = null;
      beforeSignOutReplace();
      boundary.revoke('signed-out');
    } catch { if (!boundary?.revoked) { panel.querySelector("#accountStatus").textContent = "Sign-out unavailable"; event.target.disabled = false; } }
  };
  if (!root.getElementById("callModeDialog")) {
    import("./global-call-mode.js").then(async ({ mountGlobalCallMode }) => {
      if (boundary?.revoked) return;
      const call = await mountGlobalCallMode(root);
      if (boundary?.revoked) return;
      root.querySelector("#callModeButton").onclick = () => { close(); call.open(); };
      root.querySelector("#callModeRetry").onclick = (event) => call.handleClick(event.target);
    });
  }
}

if (typeof document !== "undefined") mountAppShell();
