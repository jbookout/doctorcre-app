import type { ClientDeal, Introduction, Role } from "./deal-diagram.tsx";
import type { BroughtBy, Saved } from "./deal-vendor-menu.tsx";

export interface LinkValue {
  introductions: Introduction[];
  party: ClientDeal["vendors"][number] | null;
}

type Removal = { id: number; roles: readonly Role[] };
export type Operation =
  | { kind: "source"; by: BroughtBy }
  | { kind: "remove-introduction"; introduction: string }
  | { kind: "add"; role: Role; showSource: boolean }
  | { kind: "remove"; roles: readonly Role[] }
  | { kind: "restore"; removal: Removal };

type Save = { id: number; operation: Operation };
type Failure = Extract<Saved, { ok: false }>;
type LinkState =
  | { kind: "idle"; restored?: Removal }
  | { kind: "saving"; save: Save; slow: boolean }
  | { kind: "unconfirmed"; save: Save; checking: boolean }
  | { kind: "refused"; save: Save; failure: Failure }
  | { kind: "undoable"; removal: Removal; retried: boolean };

export interface VendorLink extends LinkValue {
  deal: string;
  vendor: string;
  name: string;
  revision: number;
  state: LinkState;
}

type LinkEvent =
  | { type: "begin"; save: Save }
  | { type: "deadline"; id: number }
  | { type: "answer"; id: number; revision: number; answer: Saved; changes: Partial<LinkValue> }
  | { type: "check"; revision: number }
  | { type: "read-failed"; revision: number }
  | { type: "read"; revision: number; value: LinkValue }
  | { type: "expire"; id: number };

export function missingRoles(link: LinkValue, roles: readonly Role[]) {
  return roles.filter((role) => !link.party?.roles.some((row) => row.role === role.role));
}

export function undoFor(link: VendorLink): Removal | undefined {
  const { state } = link;
  if (state.kind === "undoable") return state.removal;
  if (state.kind === "refused" && state.save.operation.kind === "restore") return state.save.operation.removal;
}

export function currentIntroduction(value: LinkValue) {
  return value.introductions.filter((row) => row.made_by !== "vendor").at(-1);
}

function reflects(value: LinkValue, operation: Operation) {
  switch (operation.kind) {
    case "source": {
      const source = currentIntroduction(value);
      return (source?.made_by === "client" ? "client" : (source?.introduced_by ?? "unrecorded")) === operation.by;
    }
    case "remove-introduction":
      return !value.introductions.some((row) => row.id === operation.introduction);
    case "add":
      return missingRoles(value, [operation.role]).length === 0;
    case "remove":
      return missingRoles(value, operation.roles).length === operation.roles.length;
    case "restore":
      return missingRoles(value, operation.removal.roles).length === 0;
  }
}

function sameRoles(before: LinkValue, after: LinkValue) {
  const roles = before.party?.roles ?? [];
  return roles.length === (after.party?.roles.length ?? 0) && missingRoles(after, roles).length === 0;
}

function afterRead(link: VendorLink, value: LinkValue): LinkState {
  const { state } = link;
  switch (state.kind) {
    case "idle":
      return state.restored && missingRoles(value, state.restored.roles).length ? { kind: "idle" } : state;
    case "saving":
      return state;
    case "unconfirmed": {
      if (!state.checking) return state;
      const { operation } = state.save;
      if (operation.kind !== "restore") return { kind: "idle" };
      return reflects(value, operation)
        ? { kind: "idle", restored: { id: state.save.id, roles: operation.removal.roles } }
        : { kind: "undoable", removal: operation.removal, retried: true };
    }
    case "refused": {
      const { operation } = state.save;
      const sourceConflictCleared =
        operation.kind === "source" &&
        state.failure.problem?.error === "introduction_already_recorded" &&
        value.introductions.length === 0;
      if (
        sourceConflictCleared ||
        reflects(value, operation) ||
        (operation.kind === "restore" && !sameRoles(link, value))
      )
        return { kind: "idle" };
      return state;
    }
    case "undoable":
      return sameRoles(link, value) ? state : { kind: "idle" };
  }
}

export function transitionLink(link: VendorLink, event: LinkEvent): VendorLink {
  const { state } = link;
  switch (event.type) {
    case "begin": {
      if (state.kind === "saving" || state.kind === "unconfirmed" || event.save.id <= link.revision) return link;
      const { operation } = event.save;
      if (operation.kind === "restore") {
        const undo = undoFor(link);
        if (undo?.id !== operation.removal.id || !missingRoles(link, undo.roles).length) return link;
      }
      return { ...link, revision: event.save.id, state: { kind: "saving", save: event.save, slow: false } };
    }
    case "deadline":
      return state.kind === "saving" && state.save.id === event.id && !state.slow
        ? { ...link, state: { ...state, slow: true } }
        : link;
    case "answer": {
      if (state.kind !== "saving" || state.save.id !== event.id || event.revision <= link.revision) return link;
      const { answer } = event;
      const { save } = state;
      const next = { ...link, ...event.changes, revision: event.revision };
      if (!answer.ok)
        return {
          ...next,
          state: answer.pending
            ? { kind: "unconfirmed", save, checking: false }
            : { kind: "refused", save, failure: answer },
        };
      return {
        ...next,
        state:
          save.operation.kind === "remove"
            ? { kind: "undoable", removal: { id: save.id, roles: save.operation.roles }, retried: false }
            : { kind: "idle" },
      };
    }
    case "check":
      return state.kind === "unconfirmed" && event.revision > link.revision
        ? { ...link, revision: event.revision, state: { ...state, checking: true } }
        : link;
    case "read-failed":
      return state.kind === "unconfirmed" && state.checking && event.revision > link.revision
        ? { ...link, revision: event.revision, state: { ...state, checking: false } }
        : link;
    case "read":
      if (event.revision <= link.revision || state.kind === "saving") return link;
      return { ...link, ...event.value, revision: event.revision, state: afterRead(link, event.value) };
    case "expire":
      return state.kind === "undoable" && !state.retried && state.removal.id === event.id
        ? { ...link, state: { kind: "idle" } }
        : link;
  }
}
