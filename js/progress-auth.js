// One page-wide boundary for protected projections and in-flight reads.
let generation = 0, authenticated = true;
export const authGeneration = () => generation;
export const authCurrent = epoch => epoch === generation;
export const authReadable = epoch => authenticated && authCurrent(epoch);
export function establishAuth(epoch) { if (!authCurrent(epoch)) return false; authenticated = true; return true; }
export function invalidateAuth() {
  if (!authenticated) return;
  authenticated = false; ++generation;
  document.dispatchEvent(new Event('progress-auth-lost'));
}
