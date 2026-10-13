// What /status paints in #statusIdentity once the browser has read a valid
// /app-release: a 7-hex source commit and a named environment. A missing,
// malformed or empty release paints "App build unknown" (js/status.js
// renderIdentity), and the Worker reports environment "unknown" when APP_ENV is
// unset; neither may pass the production journey.
export const RELEASE_IDENTITY = /^App build [0-9a-f]{7} · (?!unknown$)[a-z][a-z0-9-]*$/;
