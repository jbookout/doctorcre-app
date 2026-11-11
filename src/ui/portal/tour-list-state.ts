export type TourProperty = Readonly<{
  id: string;
  number: number;
  address: string;
  role: "candidate" | "market-context" | "retired";
  summary: string;
}>;
export type Selection = Readonly<{
  version: number;
  selected: readonly string[];
  notes: Readonly<Record<string, string>>;
  retired?: readonly string[];
}>;
export type Proposal = Selection & Readonly<{ idempotency_key: string }>;
type DraftState = { base: Selection; draft: Selection };
export type TourListState =
  | { kind: "loading" | "unavailable" | "expired" | "disposed" }
  | ({ kind: "ready" | "dirty" | "conflict" } & DraftState)
  | ({ kind: "saving" | "uncertain"; request: Proposal } & DraftState)
  | { kind: "signing-out" | "signout-uncertain"; key: string };
export type SelectionPorts = {
  read: (options: { signal: AbortSignal }) => Promise<unknown>;
  save: (request: Proposal, options: { signal: AbortSignal }) => Promise<unknown>;
  signOut: (options: { signal: AbortSignal; idempotency_key: string }) => Promise<void>;
  clearPrivateState: () => void;
  returnToGate: () => void;
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function status(error: unknown, code: number) {
  return record(error) && error.status === code;
}
function freeze(value: Selection): Selection {
  return Object.freeze({
    version: value.version,
    selected: Object.freeze([...value.selected].sort()),
    notes: Object.freeze(Object.setPrototypeOf({ ...value.notes }, null)),
    ...(value.retired?.length ? { retired: Object.freeze([...value.retired]) } : {}),
  });
}
function same(a: Selection, b: Selection) {
  return (
    a.selected.length === b.selected.length &&
    Object.keys(a.notes).length === Object.keys(b.notes).length &&
    a.selected.every((id, i) => id === b.selected[i] && a.notes[id] === b.notes[id])
  );
}
function parse(value: unknown, allowed: ReadonlySet<string>): Selection {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.version) ||
    typeof value.version !== "number" ||
    value.version < 0 ||
    !Array.isArray(value.selected) ||
    !record(value.notes)
  )
    throw Error("Invalid selection");
  const inputSelected = value.selected;
  const retired = value.retired ?? [];
  if (
    !Array.isArray(retired) ||
    retired.some((id) => typeof id !== "string" || allowed.has(id) || !inputSelected.includes(id)) ||
    new Set(retired).size !== retired.length
  )
    throw Error("Invalid retired property");
  const selected: string[] = [];
  for (const id of value.selected) {
    if (typeof id !== "string" || (!allowed.has(id) && !retired.includes(id)) || selected.includes(id))
      throw Error("Invalid property");
    selected.push(id);
  }
  const entries: [string, string][] = [];
  for (const [id, note] of Object.entries(value.notes)) {
    if (!selected.includes(id) || typeof note !== "string" || note.length > 2000 || note.includes("\0"))
      throw Error("Invalid note");
    entries.push([id, note]);
  }
  return freeze({ version: value.version, selected, notes: Object.fromEntries(entries), retired });
}
export function createTourList(
  publication: readonly TourProperty[],
  ports: SelectionPorts,
  newKey: () => string = () => crypto.randomUUID(),
  timeoutMs = 15_000,
) {
  let properties = publication.filter((property) => property.role === "candidate");
  const allowed = new Set(properties.map((property) => property.id));
  let state: TourListState = { kind: "loading" };
  const listeners = new Set<(state: TourListState) => void>();
  let active: AbortController | undefined;
  let generation = 0;
  let privateCleared = false;
  const emit = (next: TourListState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  const cancel = () => {
    generation++;
    active?.abort();
    active = undefined;
  };
  const clear = () => {
    properties = [];
    allowed.clear();
    if (!privateCleared) {
      privateCleared = true;
      ports.clearPrivateState();
    }
  };
  const expire = () => {
    if (state.kind === "expired" || state.kind === "disposed") return;
    cancel();
    emit({ kind: "expired" });
    clear();
    ports.returnToGate();
  };
  const call = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    success: (value: T) => void,
    failure: (error: unknown) => void,
  ) => {
    cancel();
    const ticket = generation;
    const controller = new AbortController();
    active = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    let rejectAbort: () => void = () => {};
    try {
      const deadline = new Promise<never>((_, reject) => {
        rejectAbort = () => {
          controller.abort();
          reject(Error("Request aborted"));
        };
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
      const value = await Promise.race([operation(signal), deadline]);
      if (ticket === generation) success(value);
    } catch (error) {
      if (ticket === generation) {
        if (status(error, 401)) expire();
        else failure(error);
      }
    } finally {
      signal.removeEventListener("abort", rejectAbort);
      if (ticket === generation) active = undefined;
    }
  };
  const blocked = () =>
    ["loading", "saving", "signing-out", "expired", "disposed", "signout-uncertain"].includes(state.kind);
  const hasChanges = () => ["dirty", "conflict", "uncertain", "saving"].includes(state.kind);
  const load = () => {
    emit({ kind: "loading" });
    return call(
      (signal) => ports.read({ signal }),
      (value) => {
        try {
          const base = parse(value, allowed);
          emit({ kind: "ready", base, draft: base });
        } catch {
          emit({ kind: "unavailable" });
        }
      },
      () => emit({ kind: "unavailable" }),
    );
  };
  const update = (draft: Selection) => {
    if (state.kind !== "ready" && state.kind !== "dirty") return;
    const next = freeze(draft);
    emit({ kind: same(state.base, next) ? "ready" : "dirty", base: state.base, draft: next });
  };
  const model = {
    get state() {
      return state;
    },
    get properties(): readonly TourProperty[] {
      const draft = "draft" in state ? state.draft : undefined;
      return [
        ...properties,
        ...(draft
          ? (draft.retired ?? [])
              .filter((id) => draft.selected.includes(id))
              .map(
                (id, index): TourProperty => ({
                  id,
                  number: properties.length + index + 1,
                  address: "No longer in this publication",
                  summary: id,
                  role: "retired",
                }),
              )
          : []),
      ];
    },
    get unsaved() {
      return hasChanges();
    },
    subscribe(listener: (state: TourListState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    edit(id: string, selected: boolean) {
      if (
        (state.kind !== "ready" && state.kind !== "dirty") ||
        (!allowed.has(id) && (selected || !state.draft.retired?.includes(id)))
      )
        return;
      const ids = new Set(state.draft.selected);
      if (selected) ids.add(id);
      else ids.delete(id);
      const notes = { ...state.draft.notes };
      if (!selected) delete notes[id];
      update({ ...state.draft, selected: [...ids], notes });
    },
    note(id: string, note: string) {
      if ((state.kind !== "ready" && state.kind !== "dirty") || !allowed.has(id) || !state.draft.selected.includes(id))
        return;
      update({ ...state.draft, notes: { ...state.draft.notes, [id]: note.replaceAll("\0", "").slice(0, 2000) } });
    },
    save() {
      if (state.kind !== "dirty" && state.kind !== "uncertain") return;
      const { base, draft } = state;
      const request =
        state.kind === "uncertain"
          ? state.request
          : Object.freeze({
              version: draft.version,
              selected: draft.selected,
              notes: draft.notes,
              idempotency_key: newKey(),
            });
      emit({ kind: "saving", base, draft, request });
      return call(
        (signal) => ports.save(request, { signal }),
        (value) => {
          try {
            const receipt = parse(value, allowed);
            if (receipt.version <= request.version || !same(receipt, request)) throw Error("Unconfirmed receipt");
            emit({ kind: "ready", base: receipt, draft: receipt });
          } catch {
            emit({ kind: "uncertain", base, draft, request });
          }
        },
        (error) =>
          emit(status(error, 409) ? { kind: "conflict", base, draft } : { kind: "uncertain", base, draft, request }),
      );
    },
    reload(discard = false) {
      if (blocked() || state.kind === "uncertain") return false;
      if (hasChanges() && !discard) return false;
      return load();
    },
    signOut(discard = false) {
      if (["disposed", "expired", "signing-out"].includes(state.kind)) return false;
      if (hasChanges() && !discard) return false;
      const key = state.kind === "signout-uncertain" ? state.key : newKey();
      cancel();
      emit({ kind: "signing-out", key });
      clear();
      return call(
        (signal) => ports.signOut({ signal, idempotency_key: key }),
        () => expire(),
        () => emit({ kind: "signout-uncertain", key }),
      );
    },
    expire,
    dispose() {
      if (state.kind === "disposed") return;
      cancel();
      emit({ kind: "disposed" });
      clear();
      listeners.clear();
    },
  };
  void load();
  return model;
}
export type TourListModel = ReturnType<typeof createTourList>;
