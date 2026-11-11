type Party = {
  id: string;
  name: string;
  ref: string;
  contact_state: string;
  contact_state_until: string | null;
  restricted: boolean;
};
type Edge = { id: string; from: string; to: string; via: string | null; kind: string; detail: string; when: string };
type Path = { edge: Edge; from: Party; to: Party; via: Party | null };
type Request = {
  idempotency_key: string;
  from_party: string;
  to_party: string;
  via_party?: string;
  kind: "intro_requested";
  occurred_on: string;
  note: string;
};
type Client = { getRelationshipNetwork(): Promise<unknown>; linkParties(args: Request): Promise<unknown> };
type Status =
  | "selected"
  | "reviewing"
  | "submitting"
  | "refused"
  | "unknown"
  | "confirmed"
  | "changed_source"
  | "retired";
type View = { status: Status; path: Path | null; message: string; request: Readonly<Request> | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Unreadable relationship source");
  return Object.fromEntries(Object.entries(value));
}

export function mountIntroductionRequest({
  document,
  client,
  validNetwork,
  onConfirmed,
  recoveryHost,
}: {
  document: Document;
  client: Client;
  validNetwork(value: unknown): boolean;
  onConfirmed(): void;
  recoveryHost: HTMLElement;
}) {
  const dialog = document.createElement("dialog");
  dialog.className = "introduction-review";
  dialog.setAttribute("aria-labelledby", "introReviewTitle");
  dialog.innerHTML =
    '<header><h2 id="introReviewTitle" tabindex="-1">Review introduction</h2><button type="button" data-close aria-label="Close introduction review">×</button></header><form><p>This records a requested introduction. No message is sent.</p><dl data-path></dl><p data-evidence></p><p data-status role="status"></p><label>Request date<input name="date" type="date" required></label><label>Note<textarea name="note" rows="3" required></textarea></label><label class="intro-reviewed"><input name="reviewed" type="checkbox" required>I reviewed these people and this offered path.</label><button type="submit">Record requested introduction</button><button type="button" data-recover hidden>Check same request</button></form>';
  document.body.append(dialog);
  const pending = document.createElement("button");
  pending.type = "button";
  pending.textContent = "Check introduction request";
  pending.hidden = true;
  recoveryHost.append(pending);
  pending.onclick = () => {
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("h2")?.focus();
  };
  const form = dialog.querySelector("form");
  const date = dialog.querySelector<HTMLInputElement>('[name="date"]');
  const note = dialog.querySelector<HTMLTextAreaElement>('[name="note"]');
  const reviewed = dialog.querySelector<HTMLInputElement>('[name="reviewed"]');
  const submit = dialog.querySelector<HTMLButtonElement>('[type="submit"]');
  const recover = dialog.querySelector<HTMLButtonElement>("[data-recover]");
  const identities = dialog.querySelector("[data-path]");
  const evidence = dialog.querySelector("[data-evidence]");
  const status = dialog.querySelector("[data-status]");
  if (!form || !date || !note || !reviewed || !submit || !recover || !identities || !evidence || !status)
    throw Error("Introduction controls unavailable");
  let trigger: Element | null = null;
  const model = createIntroductionRequest({ client, validNetwork, onChange: paint });
  function paint() {
    const view = model.view();
    dialog.dataset.state = view.status;
    pending.hidden = !["unknown", "submitting"].includes(view.status);
    if (!identities || !evidence || !status || !date || !note || !reviewed || !submit || !recover) return;
    identities.replaceChildren();
    evidence.textContent = "";
    if (view.path) {
      const people = [
        { label: "From", node: view.path.from },
        { label: "Introducer", node: view.path.via },
        { label: "To", node: view.path.to },
      ];
      for (const { label, node } of people) {
        const term = document.createElement("dt"),
          detail = document.createElement("dd");
        term.textContent = label;
        detail.textContent = node
          ? `${node.name} (${node.ref})`
          : "Direct offered path; no separate introducer recorded";
        detail.setAttribute("data-identity", node?.id ?? "direct");
        identities.append(term, detail);
      }
      evidence.textContent = view.path.edge.detail;
    }
    status.textContent =
      view.message ||
      (view.status === "submitting"
        ? "Checking and recording this request…"
        : "Willingness to introduce is unconfirmed.");
    const locked = view.status !== "reviewing";
    if (view.status === "retired") {
      date.value = "";
      note.value = "";
      reviewed.checked = false;
    }
    for (const control of [date, note, reviewed, submit]) control.disabled = locked;
    recover.hidden = view.status !== "unknown";
    if (view.request) {
      date.value = view.request.occurred_on;
      note.value = view.request.note;
    }
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    await model.submit(date.value, note.value, reviewed.checked);
    if (model.view().status === "confirmed") onConfirmed();
  };
  recover.onclick = async () => {
    await model.recover();
    if (model.view().status === "confirmed") onConfirmed();
  };
  const close = () => {
    dialog.close();
    if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
  };
  dialog.querySelector<HTMLButtonElement>("[data-close]")?.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  return {
    open(snapshot: unknown, id: string) {
      trigger = document.activeElement;
      const prior = model.view().status;
      model.open(snapshot, id);
      if (!["unknown", "submitting", "retired"].includes(prior)) {
        date.value = "";
        note.value = "";
        reviewed.checked = false;
      }
      if (!dialog.open) dialog.showModal();
      dialog.querySelector<HTMLElement>("h2")?.focus();
    },
    retire() {
      model.retire();
      dialog.close();
    },
    dispose() {
      model.retire();
      dialog.remove();
      pending.remove();
    },
  };
}
function text(value: unknown): string {
  if (typeof value !== "string") throw Error("Unreadable relationship identity");
  return value;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("Unreadable relationships");
  return value;
}
function edge(value: unknown): Edge {
  const row = object(value);
  return {
    id: text(row.id),
    from: text(row.from),
    to: text(row.to),
    via: row.via == null ? null : text(row.via),
    kind: text(row.kind),
    detail: row.detail == null ? "" : text(row.detail),
    when: row.when == null ? "" : text(row.when),
  };
}
function party(value: unknown): Party {
  const row = object(value),
    id = text(row.id);
  if (!id.startsWith("party:") || !uuid.test(id.slice(6))) throw Error("An introduction needs exact party identities");
  if (typeof row.restricted !== "boolean") throw Error("Restriction unavailable");
  return {
    id,
    name: text(row.name),
    ref: row.ref == null ? id.slice(6) : text(row.ref),
    contact_state: text(row.contact_state),
    contact_state_until: row.contact_state_until == null ? null : text(row.contact_state_until),
    restricted: row.restricted === true,
  };
}
function pathFrom(value: unknown, id: string, now: number): Path {
  const snapshot = object(value);
  if (Date.parse(text(snapshot.valid_until)) <= now) throw Error("Source expired");
  const suggestion = rows(snapshot.suggestions)
    .map(object)
    .find((row) => row.id === id);
  const selected = rows(snapshot.edges)
    .map(edge)
    .find((row) => row.id === id && row.kind === "can_introduce");
  if (
    !suggestion ||
    !selected ||
    suggestion.from !== selected.from ||
    suggestion.to !== selected.to ||
    suggestion.via !== selected.via
  )
    throw Error("Offer changed");
  const nodes = rows(snapshot.nodes).map(object);
  const resolve = (id: string) => party(nodes.find((node) => node.id === id));
  const path = {
    edge: selected,
    from: resolve(selected.from),
    to: resolve(selected.to),
    via: selected.via ? resolve(selected.via) : null,
  };
  const date = new Date(now).toISOString().slice(0, 10);
  if (
    !selected.detail.trim() ||
    path.from.id === path.to.id ||
    (path.via && [path.from.id, path.to.id].includes(path.via.id))
  )
    throw Error("Invalid offered path");
  for (const node of [path.from, path.to, path.via]) {
    if (
      node &&
      (node.restricted ||
        (node.contact_state !== "active" && (!node.contact_state_until || node.contact_state_until >= date)))
    )
      throw Error("Contact restrictions changed");
  }
  if (
    rows(snapshot.edges)
      .map(edge)
      .some(
        (other) =>
          ["intro_requested", "introduced", "intro", "intro_received"].includes(other.kind) &&
          [other.from, other.to].sort().join() === [selected.from, selected.to].sort().join(),
      )
  )
    throw Error("Introduction already requested or completed");
  return path;
}
export function parseLinkReceipt(value: unknown) {
  const row = object(value);
  if (
    row.ok !== true ||
    typeof row.link_id !== "string" ||
    !uuid.test(row.link_id) ||
    typeof row.existing !== "boolean"
  )
    throw Error("Introduction receipt unavailable");
  return { ok: true, link_id: row.link_id, existing: row.existing };
}
export function createIntroductionRequest({
  client,
  validNetwork,
  newKey = () => crypto.randomUUID(),
  now = Date.now,
  onChange = () => {},
}: {
  client: Client;
  validNetwork(value: unknown): boolean;
  newKey?: () => string;
  now?: () => number;
  onChange?: () => void;
}) {
  let view: View = { status: "selected", path: null, message: "", request: null };
  let generation = 0;
  function change(status: Status, message = "") {
    view = { ...view, status, message };
    onChange();
  }
  function retire(message = "Session ended.") {
    generation++;
    view = { ...view, path: null, request: null };
    change("retired", message);
  }
  function validate(value: unknown) {
    if (!validNetwork(value)) throw Error("Relationships unavailable");
    return value;
  }
  async function send(recover: boolean) {
    const request = view.request,
      path = view.path;
    if (!request || !path || view.status === "retired") return;
    const token = generation;
    change("submitting");
    const matches = (saved: Edge) =>
      saved.kind === "intro_requested" &&
      saved.from === path.from.id &&
      saved.to === path.to.id &&
      saved.via === (path.via?.id ?? null) &&
      saved.when.slice(0, 10) === request.occurred_on &&
      saved.detail === request.note;
    const sessionEnded = (error: unknown) => {
      const failure = error && typeof error === "object" ? object(error) : {};
      return failure.code === "session_changed" || failure.status === 401 || failure.status === 403;
    };
    try {
      const snapshot = object(validate(await client.getRelationshipNetwork()));
      if (token !== generation) return;
      if (Date.parse(text(snapshot.valid_until)) <= now()) throw Error("Source expired");
      const committed = recover && rows(snapshot.edges).map(edge).some(matches);
      if (!committed) {
        const next = pathFrom(snapshot, path.edge.id, now());
        if (JSON.stringify(next) !== JSON.stringify(path)) throw Error("Offer changed");
      }
    } catch (error) {
      if (token !== generation) return;
      if (sessionEnded(error)) retire("Session changed. Reopen Relationships in your original session.");
      else
        change(
          recover ? "unknown" : "changed_source",
          recover
            ? "This request could not be reconciled with the current path. Check the same request again."
            : "This offered path could not be verified. Refresh and review it again.",
        );
      return;
    }
    if (token !== generation) return;
    try {
      const receipt = parseLinkReceipt(await client.linkParties(request));
      if (token !== generation) return;
      const snapshot = object(validate(await client.getRelationshipNetwork()));
      if (token !== generation) return;
      if (Date.parse(text(snapshot.valid_until)) <= now()) throw Error("Readback expired");
      const saved = rows(snapshot.edges)
        .map(edge)
        .find((row) => row.id === `link:${receipt.link_id}`);
      if (!saved || !matches(saved)) throw Error("Exact request readback unavailable");
      change("confirmed", "Introduction requested. The refreshed connection shows the recorded request.");
    } catch (error) {
      if (token !== generation) return;
      const failure = error && typeof error === "object" ? object(error) : {};
      if (sessionEnded(error)) {
        retire("Session changed. Reopen Relationships in your original session.");
      } else if (
        failure.payload &&
        typeof failure.payload === "object" &&
        "error" in failure.payload &&
        [
          "AUTHORIZATION_REFUSED",
          "self_link",
          "via_is_an_end",
          "bad_occurred_on",
          "subject_not_found",
          "no_party_under_ref",
          "key_reuse",
        ].includes(String(failure.payload.error))
      )
        change("refused", "The server refused this request. Refresh and review the current path.");
      else
        change(
          "unknown",
          "The outcome is unknown. Keep this page open and check the same request before recording another.",
        );
    }
  }
  return {
    view: () => view,
    open(value: unknown, id: string) {
      if (["retired", "submitting", "unknown"].includes(view.status)) {
        onChange();
        return;
      }
      try {
        view = { status: "reviewing", path: pathFrom(validate(value), id, now()), message: "", request: null };
        onChange();
      } catch {
        change("changed_source", "This offered path is no longer available. Refresh Relationships.");
      }
    },
    async submit(date: string, note: string, reviewed: boolean) {
      if (
        view.status !== "reviewing" ||
        !view.path ||
        !reviewed ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
        !note.trim()
      )
        return;
      const path = view.path;
      view = {
        ...view,
        request: Object.freeze({
          idempotency_key: newKey(),
          from_party: path.from.id.slice(6),
          to_party: path.to.id.slice(6),
          ...(path.via ? { via_party: path.via.id.slice(6) } : {}),
          kind: "intro_requested",
          occurred_on: date,
          note,
        }),
      };
      await send(false);
    },
    async recover() {
      if (view.status === "unknown") await send(true);
    },
    retire() {
      retire();
    },
  };
}
