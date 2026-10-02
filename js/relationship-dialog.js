import {
  escapeHtml as E,
  EDGE_LABELS,
  shortSummary,
} from "./relationship-network-model.js";
export function mountRelationshipDialog({ document }) {
  const dialog = document.createElement("dialog");
  dialog.className = "relationship-dialog";
  dialog.setAttribute("aria-labelledby", "relationshipTitle");
  document.body.append(dialog);
  let snapshot, selected, returnFocus;
  const paint = () => {
    const node = snapshot?.nodes.find((n) => n.id === selected);
    if (!node) {
      dialog.close();
      return;
    }
    const expanded = new Set(
      [...dialog.querySelectorAll("details[open]")].map((d) => d.dataset.entry),
    );
    const focused = dialog.contains(document.activeElement)
      ? document.activeElement.dataset.cardKey
      : null;
    const edges = snapshot.edges.filter((e) =>
      [e.from, e.to, e.via].includes(node.id),
    );
    const refs = snapshot.referrals.find((r) => r.node_id === node.id);
    dialog.innerHTML = `<header><div><span class="relationship-kicker">${E(node.kind)}</span><h2 id="relationshipTitle" tabindex="-1">${E(node.name)}</h2></div><button data-card-key="close" data-close-card type="button" aria-label="Close relationship">×</button></header><div class="relationship-detail-grid"><section><div class="relationship-tags">${[
      node.territory,
      ...node.verticals,
      node.owner,
    ]
      .filter(Boolean)
      .map((v) => `<span>${E(v)}</span>`)
      .join(
        "",
      )}</div>${node.contact_state && node.contact_state !== "active" ? `<span class="relationship-hold">Contact hold</span>` : ""}${node.summary ? `<p class="relationship-summary">${E(shortSummary(node.summary))}</p><details data-entry="summary"><summary data-card-key="summary">Details</summary><p>${E(node.summary)}</p></details>` : ""}${refs ? `<div class="relationship-metrics"><div><strong>${refs.deals}</strong><span>Deals sent</span></div><div><strong>${refs.win_rate === null ? "—" : `${Math.round(refs.win_rate * 100)}%`}</strong><span>Win rate · ${refs.won} won / ${refs.won + refs.lost} resolved</span></div></div>` : ""}</section><section><h3>Connections</h3>${
      edges
        .map((e) => {
          const other = snapshot.nodes.find(
            (n) => n.id === (e.from === node.id ? e.to : e.from),
          );
          const via = snapshot.nodes.find((n) => n.id === e.via);
          return `<article class="relationship-entry"><span>${E(EDGE_LABELS[e.kind])}${via ? ` · via ${E(via.name)}` : ""}</span><button type="button" data-open-node="${E(other.id)}" data-card-key="${E(e.id)}">${E(other.name)} <span aria-hidden="true">↗</span></button>${e.summary ? `<p>${E(shortSummary(e.summary))}</p>` : ""}${e.when ? `<time>${E(new Date(e.when).toLocaleDateString())}</time>` : ""}${e.detail ? `<details data-entry="${E(e.id)}"><summary data-card-key="detail:${E(e.id)}">Details</summary><p>${E(e.detail)}</p></details>` : ""}</article>`;
        })
        .join("") || "<p>No connections recorded</p>"
    }</section></div>`;
    dialog.querySelector("[data-close-card]").onclick = () => dialog.close();
    dialog.querySelectorAll("[data-open-node]").forEach(
      (b) =>
        (b.onclick = () => {
          selected = b.dataset.openNode;
          paint();
          dialog.querySelector("h2").focus();
        }),
    );
    dialog.querySelectorAll("details").forEach((d) => {
      d.open = expanded.has(d.dataset.entry);
    });
    if (focused)
      (
        [...dialog.querySelectorAll("[data-card-key]")].find(
          (n) => n.dataset.cardKey === focused,
        ) || dialog.querySelector("[data-close-card]")
      ).focus();
  };
  dialog.addEventListener("close", () => {
    selected = null;
    if (returnFocus?.isConnected) {
      returnFocus.focus();
      return;
    }
    const key = returnFocus?.dataset.node || returnFocus?.dataset.introNode;
    if (key) {
      const replacement = [
        ...document.querySelectorAll("[data-node],[data-intro-node]"),
      ].find((n) => (n.dataset.node || n.dataset.introNode) === key);
      replacement?.focus();
    }
  });
  return {
    open(value, id, trigger = document.activeElement) {
      snapshot = value;
      selected = id;
      returnFocus = trigger;
      paint();
      if (selected) {
        if (!dialog.open) dialog.showModal();
        dialog.querySelector("h2").focus();
      }
    },
    update(value) {
      snapshot = value;
      if (dialog.open) paint();
    },
    clear() {
      snapshot = null;
      selected = null;
      dialog.close();
    },
    dispose() {
      dialog.close();
      dialog.remove();
    },
  };
}
