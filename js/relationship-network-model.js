export const NETWORK_SCHEMA = "carr-relationship-network.v1";
export const EDGE_LABELS = Object.freeze({
  knows: "Knows",
  works_with: "Works with",
  can_introduce: "Can introduce",
  intro_requested: "Introduction requested",
  introduced: "Introduced",
  intro: "Introduced",
  intro_received: "Introduction received",
  referral: "Referred",
  referred: "Referred",
  worked: "Worked on",
  client_deal: "Client deal",
});
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function validNetwork(value) {
  if (
    value?.schema !== NETWORK_SCHEMA ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    !Number.isFinite(Date.parse(value.valid_until)) ||
    Date.parse(value.valid_until) <= Date.parse(value.observed_at) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.referrals) ||
    !Array.isArray(value.suggestions)
  )
    return false;
  const ids = new Set();
  for (const node of value.nodes) {
    if (
      !node ||
      typeof node.id !== "string" ||
      !node.id ||
      ids.has(node.id) ||
      typeof node.name !== "string" ||
      !node.name.trim() ||
      !["vendor", "client", "lead", "deal", "contact"].includes(node.kind) ||
      !Array.isArray(node.verticals) ||
      node.verticals.some((v) => typeof v !== "string")
    )
      return false;
    ids.add(node.id);
  }
  const edges = new Set();
  for (const edge of value.edges) {
    if (
      !edge ||
      typeof edge.id !== "string" ||
      edges.has(edge.id) ||
      !ids.has(edge.from) ||
      !ids.has(edge.to) ||
      edge.from === edge.to ||
      (edge.via && !ids.has(edge.via)) ||
      !EDGE_LABELS[edge.kind]
    )
      return false;
    edges.add(edge.id);
  }
  const referrers = new Set();
  if (
    !value.referrals.every((row) => {
      if (
        !ids.has(row.node_id) ||
        referrers.has(row.node_id) ||
        !["deals", "won", "lost"].every(
          (k) => Number.isInteger(row[k]) && row[k] >= 0,
        ) ||
        row.won + row.lost > row.deals ||
        row.win_rate !==
          (row.won + row.lost ? row.won / (row.won + row.lost) : null)
      )
        return false;
      referrers.add(row.node_id);
      return true;
    })
  )
    return false;
  return value.suggestions.every(
    (row) =>
      edges.has(row.id) &&
      ids.has(row.from) &&
      ids.has(row.to) &&
      (!row.via || ids.has(row.via)) &&
      typeof row.reason === "string" &&
      row.reason.trim() &&
      value.edges.some(
        (edge) =>
          edge.id === row.id &&
          edge.kind === "can_introduce" &&
          edge.from === row.from &&
          edge.to === row.to &&
          edge.via === row.via,
      ),
  );
}
export function filterNetwork(
  snapshot,
  { territory = "", vertical = "", q = "" } = {},
) {
  const nodes = snapshot.nodes.filter(
    (n) =>
      (!territory || n.territory === territory) &&
      (!vertical || n.verticals.includes(vertical)) &&
      (!q ||
        `${n.name} ${n.summary || ""}`
          .toLocaleLowerCase()
          .includes(q.toLocaleLowerCase())),
  );
  const ids = new Set(nodes.map((n) => n.id));
  return {
    ...snapshot,
    nodes,
    edges: snapshot.edges.filter(
      (e) => ids.has(e.from) && ids.has(e.to) && (!e.via || ids.has(e.via)),
    ),
    referrals: snapshot.referrals.filter((r) => ids.has(r.node_id)),
    suggestions: snapshot.suggestions.filter(
      (r) => ids.has(r.from) && ids.has(r.to) && (!r.via || ids.has(r.via)),
    ),
  };
}
export function introductionSuggestions(
  snapshot,
  { scope = "team", actor, limit = 3, now = Date.now() } = {},
) {
  if (!validNetwork(snapshot) || Date.parse(snapshot.valid_until) <= now)
    return [];
  const nodes = new Map(snapshot.nodes.map((n) => [n.id, n]));
  return snapshot.suggestions
    .filter(
      (s) =>
        scope !== "mine" ||
        (actor &&
          [s.from, s.to, s.via].some((id) => nodes.get(id)?.owner === actor)),
    )
    .slice(0, limit)
    .map((s) => ({
      ...s,
      fromNode: nodes.get(s.via || s.from),
      toNode: nodes.get(s.to),
    }));
}
export function focusedNetwork(snapshot, focus, limit = 12) {
  const candidates = new Set([focus]);
  snapshot.edges.forEach((e) => {
    if ([e.from, e.to, e.via].includes(focus))
      [e.from, e.to, e.via].filter(Boolean).forEach((id) => candidates.add(id));
  });
  const ordered = [...candidates, ...snapshot.nodes.map((n) => n.id)].filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  const ids = new Set(ordered.slice(0, limit));
  return {
    ...snapshot,
    nodes: snapshot.nodes.filter((n) => ids.has(n.id)),
    edges: snapshot.edges.filter((e) =>
      [e.from, e.to, e.via].filter(Boolean).every((id) => ids.has(id)),
    ),
    total: snapshot.nodes.length,
  };
}
export function shortSummary(text) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}
