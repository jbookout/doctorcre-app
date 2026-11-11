const SCOPES = new Map([
  ["view_packet", "View tour"],
  ["view_map", "View map"],
  ["download", "Download PDF"],
  ["comment", "Comment"],
  ["shortlist", "Shortlist"],
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export async function grantReceipt(payload: object) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload))),
  );
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function prepareClientGrant(options: {
  projectionId: string;
  scopes: string[];
  expiresAt: string;
  grantId?: string;
  now?: number;
}) {
  const { projectionId, scopes, expiresAt, grantId } = options;
  const now = options.now ?? Date.now();
  if (
    !UUID.test(projectionId) ||
    (grantId !== undefined && !UUID.test(grantId)) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= now ||
    !scopes.length ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !SCOPES.has(scope)) ||
    (scopes.some((scope) => scope === "comment" || scope === "shortlist" || scope === "download") &&
      !scopes.includes("view_packet"))
  )
    throw Error("Choose tour access and a future expiry.");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const tokenBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const payload = {
    projection_id: projectionId,
    token_digest: `sha256:${[...tokenBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    permission_scopes: [...scopes],
    expires_at: new Date(expiresAt).toISOString(),
    idempotency_key: crypto.randomUUID(),
    ...(grantId ? { share_grant_id: grantId } : {}),
  };
  return { token, payload: { ...payload, receipt_digest: await grantReceipt(payload) } };
}
export function renderClientGrants(list: HTMLElement, value: unknown, now = Date.now()) {
  list.replaceChildren();
  if (!Array.isArray(value)) {
    list.textContent = "Links could not be read. Refresh this tour.";
    return;
  }
  for (const grant of value) {
    if (!record(grant) || typeof grant.share_grant_id !== "string" || !UUID.test(grant.share_grant_id)) continue;
    const expiry = typeof grant.expires_at === "string" ? Date.parse(grant.expires_at) : NaN;
    const active = grant.status === "active" && Number.isFinite(expiry) && expiry > now;
    const status =
      grant.status === "revoked"
        ? "Revoked"
        : grant.status === "rotated"
          ? "Replaced"
          : grant.status === "expired" || (Number.isFinite(expiry) && expiry <= now)
            ? "Expired"
            : active
              ? "Active"
              : "Unavailable";
    const document = list.ownerDocument;
    const row = document.createElement("li");
    row.className = "client-grant-row";
    const details = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = status;
    const permissions = document.createElement("p");
    permissions.textContent = Array.isArray(grant.permission_scopes)
      ? grant.permission_scopes
          .filter((scope): scope is string => typeof scope === "string" && SCOPES.has(scope))
          .map((scope) => SCOPES.get(scope))
          .join(" · ")
      : "Permissions unavailable";
    const expires = document.createElement("p");
    expires.textContent = Number.isFinite(expiry)
      ? `${active ? "Expires" : "Expiry"} ${new Date(expiry).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
      : "Expiry unavailable";
    details.append(heading, permissions, expires);
    row.append(details);
    if (active) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Revoke link";
      button.dataset.shareGrantId = grant.share_grant_id;
      row.append(button);
    }
    list.append(row);
  }
  if (!list.children.length) list.textContent = "No client links yet. Create a link after publishing the tour.";
}
