// Build subprocesses receive process settings, never inherited deploy/auth keys.
export function credentialFreeEnv(source = process.env) {
  const names = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "SSL_CERT_FILE", "SSL_CERT_DIR", "PLAYWRIGHT_BROWSERS_PATH"];
  return Object.fromEntries(names.filter(name => typeof source[name] === "string").map(name => [name, source[name]]));
}
