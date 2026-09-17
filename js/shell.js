// The shell every DoctorCRE surface shares: the three presentation icons, the
// tab strip, and the one floating Doc.
//
// Each of those was written three times — once in js/design-prototype.js, once
// in js/work-inventory.js, once again in js/task-records.js — and the copies had
// already drifted: the prototype kept its preferences under
// "doctorcre.presentation.v1" while the product pages used
// "doctorcre.visual-preferences", so a person who set a light theme on the
// prototype and then opened a product page was shown the dark one back. One
// module now owns all three, and it MIGRATES the legacy key rather than
// pretending the older choice was never made.
//
// The markup stays literal in each page. This file wires what is already there
// and never injects a shell, because the static suites read the HTML.
import { DEFAULT_PREFERENCES, preferenceAttributes, resolvePreferences } from "./visual-system.js";

export { mountDocDock } from "./doc-dock.js";

export const PREFERENCES_KEY = "doctorcre.visual-preferences";
export const LEGACY_PREFERENCE_KEYS = Object.freeze(["doctorcre.presentation.v1"]);

const PREF_WORDS = {
  theme: { light: "Light theme", dark: "Dark theme" },
  density: { compact: "Compact density", comfortable: "Comfortable density" },
  motion: { reduced: "Motion paused", full: "Motion on" },
};

function parse(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * What is stored for this person, after the one-time move off any legacy key.
 *
 * A legacy key is read ONLY when the current key holds nothing: a person who has
 * since made a choice under the current key is never taken back to an older one.
 * The legacy entry is removed as it is migrated, so the read happens once and the
 * page writes exactly one key from then on.
 *
 * Storage is a convenience and never a requirement: a browser that refuses it
 * (private mode, blocked site data) falls through to the defaults.
 *
 * @param {Storage|null} storage
 * @param {{storageKey?: string, legacyKeys?: string[]}} [options]
 */
export function migratePreferences(storage, { storageKey = PREFERENCES_KEY, legacyKeys = LEGACY_PREFERENCE_KEYS } = {}) {
  if (!storage) return {};
  let current = {};
  try {
    current = parse(storage.getItem(storageKey));
  } catch {
    return {};
  }
  if (Object.keys(current).length > 0) {
    for (const key of legacyKeys) {
      try { storage.removeItem(key); } catch { /* a convenience, never a requirement */ }
    }
    return current;
  }
  for (const key of legacyKeys) {
    let legacy = {};
    try { legacy = parse(storage.getItem(key)); } catch { continue; }
    try { storage.removeItem(key); } catch { /* a convenience, never a requirement */ }
    if (Object.keys(legacy).length === 0) continue;
    try { storage.setItem(storageKey, JSON.stringify(legacy)); } catch { /* a convenience, never a requirement */ }
    return legacy;
  }
  return current;
}

function systemPreferences() {
  return { prefersReducedMotion: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true };
}

/** Each preference is ONE icon button: filled is on, hollow is off, and the only words are the label. */
export function applyPreferences(preferences) {
  for (const [name, value] of Object.entries(preferenceAttributes(preferences))) document.documentElement.setAttribute(name, value);
  document.querySelectorAll("button[data-pref][data-on]").forEach((button) => {
    const key = button.dataset.pref;
    const on = preferences[key] === button.dataset.on;
    button.setAttribute("aria-pressed", String(on));
    const words = `${PREF_WORDS[key][preferences[key]]}. Switch to ${PREF_WORDS[key][on ? button.dataset.off : button.dataset.on].toLowerCase()}.`;
    button.setAttribute("aria-label", words);
    button.setAttribute("title", words);
  });
  const live = document.getElementById("prefsLive");
  if (live) live.textContent = `${PREF_WORDS.theme[preferences.theme]}, ${PREF_WORDS.density[preferences.density]}, ${PREF_WORDS.motion[preferences.motion]}.`;
}

/**
 * Wire the three presentation icons on the page that is already rendered.
 *
 * @param {{storageKey?: string, legacyKeys?: string[], storage?: Storage|null}} [options]
 * @returns {{current: () => object}}
 */
export function mountPrefs({ storageKey = PREFERENCES_KEY, legacyKeys = LEGACY_PREFERENCE_KEYS, storage } = {}) {
  const store = storage === undefined ? (globalThis.localStorage || null) : storage;
  const system = systemPreferences();
  let current = resolvePreferences({ ...DEFAULT_PREFERENCES, ...migratePreferences(store, { storageKey, legacyKeys }) }, system);
  applyPreferences(current);
  document.querySelectorAll("button[data-pref][data-on]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.pref;
    const next = current[key] === button.dataset.on ? button.dataset.off : button.dataset.on;
    current = resolvePreferences({ ...current, [key]: next }, system);
    try { store?.setItem(storageKey, JSON.stringify(current)); } catch { /* a convenience, never a requirement */ }
    applyPreferences(current);
  }));
  return { current: () => ({ ...current }) };
}

/**
 * One screen at a time. A "go to" link elsewhere on the page switches tabs
 * instead of scrolling; a tab that names another page is an ordinary link and is
 * left alone, so the browser's own Back, a middle click and a screen reader all
 * behave as they always do.
 */
export function wireTabs(listId) {
  const strip = document.getElementById(listId);
  if (!strip) return null;
  const tabs = [...strip.querySelectorAll('[role="tab"]')];
  if (tabs.length === 0) return null;
  const select = (tab, focus = true) => {
    for (const candidate of tabs) {
      const chosen = candidate === tab;
      candidate.setAttribute("aria-selected", String(chosen));
      candidate.tabIndex = chosen ? 0 : -1;
      const panel = document.getElementById(candidate.getAttribute("aria-controls"));
      if (panel) panel.hidden = !chosen;
    }
    if (focus) tab.focus();
  };
  strip.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) select(tab);
  });
  strip.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step) { event.preventDefault(); select(tabs[(index + step + tabs.length) % tabs.length]); }
    if (event.key === "Home") { event.preventDefault(); select(tabs[0]); }
    if (event.key === "End") { event.preventDefault(); select(tabs[tabs.length - 1]); }
  });
  select(tabs.find((tab) => tab.getAttribute("aria-selected") === "true") || tabs[0], false);
  // Any in-page link that names a tab switches to it rather than scrolling.
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-tab]");
    if (!link) return;
    const tab = document.getElementById(link.dataset.tab);
    if (!tab) return;
    event.preventDefault();
    select(tab);
    document.querySelectorAll(".mobile-nav a").forEach((item) => item.toggleAttribute("aria-current", item === link));
    if (link.hasAttribute("aria-current")) link.setAttribute("aria-current", "page");
  });
  return { select: (id) => { const tab = document.getElementById(id); if (tab) select(tab); } };
}
