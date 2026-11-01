import { privateSession } from './private-session.js';
import { mountAppLayout } from "./app-layout.js";
import { TOUCH_LAYOUT } from "./touch-layout.js";
import { mountPrefs } from "./shell.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountAutoRefresh } from "./auto-refresh.mjs";
import { mountNavigation, appOriginForReport } from "./navigation.js";

// Keep this variable import out of the offline Tour dependency walk; its bundle is generated later.
const REACT_UI_MODULE = "./ui.generated.js";

export function mountAppShell(root = document, pathname = globalThis.location?.pathname || "/") {
  const location = globalThis.location;
  const host = mountNavigation(root, pathname, { location });
  if (!host) return;
  const base = appOriginForReport(location?.origin || "");
  let disposeDocPresence = () => {};
  const reactWorkspace = new URLSearchParams(location?.search || "").get("ui") === "react";
  if (!base) mountAccount(root, host, pathname, () => disposeDocPresence(), reactWorkspace);
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
    // Four named destinations and More fill the phone bar; the rest move into More.
    const moreToggle = host.querySelector(".app-shell-more-toggle"), moreList = host.querySelector(".app-shell-more-list");
    const overflow = ["/vendors", "/control-room"].map(href => host.querySelector(`[data-app-nav-item][href$="${href}"]`)).filter(Boolean);
    const overflowSection = root.createElement("div");
    overflowSection.className = "app-shell-more-section";
    overflowSection.innerHTML = '<span class="app-shell-more-group">Pages</span>';
    const moreCurrent = moreToggle.classList.contains("app-shell-more-current");
    const arrangeNavigation = () => {
      if (phone.matches) { overflowSection.append(...overflow); moreList.prepend(overflowSection); }
      else { moreToggle.parentElement.before(...overflow); overflowSection.remove(); }
      moreToggle.classList.toggle("app-shell-more-current", moreCurrent || phone.matches && overflow.some(link => link.hasAttribute("aria-current")));
    };
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
    phone.addEventListener("change", arrangeNavigation);
    arrangeControls();
    arrangeNavigation();
    const mountDoc = async () => {
      const { mountDocPresence } = await import('./doc-presence.js');
      if (!host.isConnected || privateSession()?.revoked) return;
      const docPresence = mountDocPresence({ document:root, window:root.defaultView });
      disposeDocPresence = () => docPresence?.dispose();
      root.dispatchEvent(new root.defaultView.Event('doctorcre:doc-ready'));
    };
    const inbox = root.getElementById('homeRoot');
    if (inbox && !inbox.hasAttribute('data-home-mounted')) root.addEventListener('doctorcre:home-mounted', () => void mountDoc(), { once: true });
    else void mountDoc();
  }
}

export function partnerIdentity(session) {
  const slug = session?.actor?.slug;
  return slug === "joe" || slug === "dell" ? { slug, name: slug === "joe" ? "Joe" : "Dell", initial: slug === "joe" ? "J" : "D" } : null;
}

function mountFlaggedWorkspace(root, pathname, sessionIsValid) {
  const win = root.defaultView;
  const phone = win.matchMedia(pathname === "/leads" ? "(max-width:1023px)" : TOUCH_LAYOUT);
  let identity = null, workspace = null, container = null, layout = null, observer = null, loading = false, disposed = false;
  let sidebarWidth = 236, todayWidth = 260;
  const tabs = id => ({ kind: "tabs", id: `${id}-group`, panels: [id], active: id });
  const stageLayout = () => {
    const sidebar = layout.dataset.sidebar === "open", today = layout.dataset.today === "open";
    const width = Math.max(1, layout.clientWidth);
    const mainWidth = Math.max(1, width - (sidebar ? sidebarWidth : 0) - (today ? todayWidth : 0));
    let stage = tabs("main");
    if (today) stage = { kind: "split", id: "main-today", axis: "horizontal", ratio: mainWidth / (mainWidth + todayWidth), first: stage, second: tabs("today") };
    if (sidebar) stage = { kind: "split", id: "sidebar-main", axis: "horizontal", ratio: sidebarWidth / (sidebarWidth + mainWidth + (today ? todayWidth : 0)), first: tabs("sidebar"), second: stage };
    return { version: 1, stage };
  };
  const restore = () => {
    observer?.disconnect(); observer = null;
    workspace?.unmount(); workspace = null;
    container?.remove(); container = null;
    layout?.classList.remove("is-react-workspace");
  };
  const reconcile = async () => {
    if (disposed || !identity || phone.matches || !sessionIsValid()) { restore(); return; }
    if (workspace) { workspace.update(stageLayout()); return; }
    if (loading) return;
    loading = true;
    try {
      const { mountZoomableWorkspace } = await import(REACT_UI_MODULE);
      if (disposed || !identity || phone.matches || !sessionIsValid()) return;
      layout = root.getElementById("appLayout");
      if (!layout) return;
      const sidebar = layout.querySelector("#appSidebar"), main = layout.querySelector(".app-layout-center"), today = layout.querySelector("#appToday");
      if (!sidebar || !main || !today) return;
      sidebarWidth = sidebar.getBoundingClientRect().width || sidebarWidth;
      todayWidth = today.getBoundingClientRect().width || todayWidth;
      const panels = [{ id: "sidebar", title: "Workspace", node: sidebar }, { id: "main", title: "Page", node: main }, { id: "today", title: "Today", node: today }];
      const initial = stageLayout();
      container = root.createElement("div");
      container.dataset.appWorkspace = "";
      layout.append(container);
      workspace = mountZoomableWorkspace({ container, panels, layout: initial });
      layout.classList.add("is-react-workspace");
      observer = new win.MutationObserver(() => { void reconcile(); });
      observer.observe(layout, { attributes: true, attributeFilter: ["data-sidebar", "data-today"] });
    } catch { restore(); }
    finally { loading = false; }
  };
  phone.addEventListener("change", reconcile);
  win.addEventListener("resize", reconcile);
  return {
    setIdentity(next) {
      if (identity?.slug === next?.slug) return;
      restore();
      identity = next;
      void reconcile();
    },
    dispose() {
      disposed = true; identity = null; restore();
      phone.removeEventListener("change", reconcile);
      win.removeEventListener("resize", reconcile);
    },
  };
}

function mountAccount(root, host, pathname, beforeSignOutReplace = () => {}, reactWorkspaceRequested = false) {
  const preferences = mountPrefs();
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
  const help = panel.querySelector("#accountHelp");
  if (help) help.onclick = async () => {
    close();
    const { openWalkthrough } = await import("./app-walkthrough.js");
    if (!boundary?.revoked) openWalkthrough(root);
  };
  root.addEventListener("click", (event) => { if (!panel.contains(event.target) && !avatar.contains(event.target)) close(); });
  root.addEventListener("keydown", (event) => { if (event.key === "Escape" && !panel.hidden) { close(); avatar.focus(); } });
  const assist = host.querySelector("#colorAssistButton");
  const applyAssist = (enabled) => { root.documentElement.dataset.colorAssist = enabled ? "on" : "off"; assist.setAttribute("aria-pressed", String(enabled)); };
  try { applyAssist(localStorage.getItem("dealroom-color-assist") === "on"); } catch { applyAssist(false); }
  assist.onclick = () => { const enabled = root.documentElement.dataset.colorAssist !== "on"; applyAssist(enabled); try { localStorage.setItem("dealroom-color-assist", enabled ? "on" : "off"); } catch {} };
  const boot = resolveDealroomBoot(globalThis.location);
  const boundary = privateSession();
  const workspace = reactWorkspaceRequested && pathname !== "/share" ? mountFlaggedWorkspace(root, pathname, () => !boundary?.revoked) : null;
  globalThis.window?.addEventListener("doctorcre-session-invalidated", () => { workspace?.dispose(); beforeSignOutReplace(); }, {once:true});
  let lastVerified = null;
  const sessionStatus = root.createElement('p');
  sessionStatus.setAttribute('role','status'); sessionStatus.hidden = true;
  host.after(sessionStatus);
  const showFirstWalkthrough = () => {
    const identity = partnerIdentity(session);
    if (boot.mode === "live" && ["/", "/home"].includes(pathname) && identity && help && root.getElementById('docOpen') && !preferences.hasSeenWalkthrough(identity.slug)) {
      void import("./app-walkthrough.js").then(({ openWalkthrough }) => {
        if (boundary.revoked || root.querySelector('dialog:modal') || !root.getElementById('docOpen') || preferences.hasSeenWalkthrough(identity.slug)) return;
        openWalkthrough(root);
        preferences.rememberWalkthrough(identity.slug);
      }).catch(() => {});
    }
  };
  root.addEventListener('doctorcre:doc-ready', showFirstWalkthrough, { once: true });
  const readIdentity = async () => {
    try {
      if (boot.mode === "fixture") session = { actor: { slug: boot.options.selfActor || "joe" } };
      else {
        session = await boundary.verify();
        lastVerified = new Date().toLocaleTimeString(); sessionStatus.hidden = true;
        panel.querySelector("#accountStatus").textContent = "";
      }
      const identity = partnerIdentity(session);
      showPartner(identity);
      workspace?.setIdentity(identity);
      showFirstWalkthrough();
    } catch {
      if (!boundary?.revoked) {
        sessionStatus.textContent = lastVerified ? `Connection unavailable · Last verified ${lastVerified}` : 'Sign-in unavailable';
        sessionStatus.hidden = false;
      }
    }
  };
  readIdentity();
  mountAutoRefresh({ document: root, window: globalThis.window, refresh: readIdentity });
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
      boundary.revoke('signed-out');
    } catch { if (!boundary?.revoked) { panel.querySelector("#accountStatus").textContent = "Sign-out unavailable"; event.target.disabled = false; } }
  };
  if (pathname === "/calls") root.querySelector(".app-shell-call-availability").hidden = true;
  if (pathname !== "/calls" && !root.getElementById("callModeDialog")) {
    import("./global-call-mode.js").then(async ({ mountGlobalCallMode }) => {
      if (boundary?.revoked) return;
      const call = await mountGlobalCallMode(root);
      if (boundary?.revoked) { call.dispose(); return; }
      root.querySelector("#callModeButton").onclick = () => { close(); call.open(); };
      root.querySelector("#callModeRetry").onclick = (event) => call.handleClick(event.target);
    });
  }
}

if (typeof document !== "undefined") mountAppShell();
