// Presentation of doctorcre-resource-dashboard.v1. The server owns the
// observations and the freshness decision; this model preserves both.
export const RESOURCE_PROVIDERS = Object.freeze([
  { id: "neon", name: "Neon" },
  { id: "github", name: "GitHub" },
  { id: "cloudflare", name: "Cloudflare" },
  { id: "local_compute", name: "Local compute" },
  { id: "model_route", name: "Model routing" },
]);

const STATES = new Set(["ok", "partial", "stale", "unconfigured", "collector_absent", "host_offline"]);
const textOrNull = (value) => typeof value === "string" && value.trim() ? value : null;
const numberOrNull = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const objectOrNull = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;

const missing = (provider, reason) => ({
  provider, name: RESOURCE_PROVIDERS.find((item) => item.id === provider).name,
  state: "unknown", reason, account: null, project: null, product: null,
  period: null, as_of: null, observed_at: null, source: null,
  quantity: null, quantity_unit: null, allowance: null, policy: null,
  estimate: null, charge: null, measured_capacity: null,
  configured_capacity: null, model_route: null,
});

export function projectResourceDashboard(payload) {
  const valid = payload?.ok === true && payload.schema === "doctorcre-resource-dashboard.v1"
    && Array.isArray(payload.providers);
  const rows = valid ? payload.providers : [];
  const providers = RESOURCE_PROVIDERS.map(({ id, name }) => {
    const matches = rows.filter((row) => row?.provider === id);
    if (matches.length !== 1 || !STATES.has(matches[0].state))
      return missing(id, valid ? "provider entry missing or invalid in this read" : "resource read unavailable");
    const row = matches[0];
    return {
      provider: id, name, state: row.state,
      reason: textOrNull(row.reason), account: textOrNull(row.account),
      project: textOrNull(row.project), product: textOrNull(row.product),
      period: textOrNull(row.period), as_of: textOrNull(row.as_of),
      observed_at: textOrNull(row.observed_at), source: textOrNull(row.source),
      quantity: numberOrNull(row.quantity), quantity_unit: textOrNull(row.quantity_unit),
      allowance: numberOrNull(row.allowance), policy: objectOrNull(row.policy),
      estimate: numberOrNull(row.estimate), charge: numberOrNull(row.charge),
      measured_capacity: objectOrNull(row.measured_capacity),
      configured_capacity: objectOrNull(row.configured_capacity),
      model_route: objectOrNull(row.model_route),
    };
  });
  return {
    schema: valid ? payload.schema : null,
    generated_at: valid ? textOrNull(payload.generated_at) : null,
    providers,
    evidenceCount: providers.filter((row) => row.source && row.observed_at).length,
    unconfiguredCount: providers.filter((row) => row.state === "unconfigured").length,
    collectorAbsentCount: providers.filter((row) => row.state === "collector_absent").length,
  };
}
