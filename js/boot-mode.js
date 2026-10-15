export const REVIEWED_DEALROOM_HOSTS = Object.freeze([
  "app.doctorcre.com",
  "carr-mcp-staging.joe-bookout-carr-us.workers.dev",
  "doctorcre-app-staging.joe-bookout-carr-us.workers.dev",
]);
const LIVE_HOSTS = new Set(REVIEWED_DEALROOM_HOSTS);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function deploymentIdentity(mode) {
  if (mode === "live") return {
    label: "LIVE · DoctorCRE",
    detail: "Connected to the live DoctorCRE Deal Room",
    mode: "live",
  };
  return {
    label: "LOCAL FIXTURE · Demo",
    detail: "Local fixture data only — changes are not production records",
    mode: "fixture",
  };
}

export function resolveDealroomBoot(locationLike) {
  const hostname = String(locationLike?.hostname || "").toLowerCase();
  const params = new URLSearchParams(locationLike?.search || "");
  const requested = params.get("mode");
  const reviewedDeployment = LIVE_HOSTS.has(hostname);
  const explicitLocalLive = LOCAL_HOSTS.has(hostname) && requested === "live";

  if (reviewedDeployment || explicitLocalLive) return { mode: "live", options: {} };
  const selfActor = params.get("actor") || undefined;
  return { mode: "fixture", options: selfActor ? { selfActor } : {} };
}
