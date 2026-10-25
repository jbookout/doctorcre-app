(() => {
  "use strict";

  // V2: the client report follows the reader's OS theme; css/tokens.css is
  // inlined into share.css and reads data-theme from <html> before first paint.
  try {
    document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch { document.documentElement.dataset.theme = "dark"; }

  const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  const params = new URLSearchParams(fragment);
  const candidate = /^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment
    : (params.size === 1 && params.has("token") ? params.get("token") : "");
  let token = /^[A-Za-z0-9_-]{43}$/.test(candidate || "") ? candidate : "";

  // Scrub the bearer before any optional renderer dependency is requested.
  window.history.replaceState(fragment ? null : window.history.state, document.title, `${window.location.pathname}${window.location.search}`);
  Object.defineProperty(globalThis, "__CARR_TOUR_TAKE_SHARE_TOKEN__", {
    configurable: true,
    value() {
      const value = token;
      token = "";
      delete globalThis.__CARR_TOUR_TAKE_SHARE_TOKEN__;
      return value;
    },
  });
})();
