export async function waitForLiveRelease({ expectedSha, read, wait, attempts = 12, intervalMs = 5000 }) {
  let observed = null;
  let readError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      observed = await read();
      readError = null;
      if (observed?.source_commit === expectedSha && observed?.environment === "production") {
        return observed;
      }
    } catch (error) {
      readError = error;
    }
    if (attempt < attempts) await wait(intervalMs);
  }
  const source = observed?.source_commit ?? "missing";
  const environment = observed?.environment ?? "missing";
  const errorKind = readError ? ` last_read_error=${readError.name || "Error"}` : "";
  throw new Error(`production /app-release did not reach ${expectedSha} after ${attempts} reads; `
    + `source_commit=${source} environment=${environment}${errorKind}`);
}
