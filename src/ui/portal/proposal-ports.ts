import type { Proposal, Selection, SelectionPorts, TourProperty } from "./tour-list-state.ts";

export type ProposalScope = Readonly<{ publication_id: string; publication_version: number }>;
export type ProposalTransport = {
  read: (options: { signal: AbortSignal }) => Promise<unknown>;
  save: (publicationVersion: number, request: Proposal, options: { signal: AbortSignal }) => Promise<unknown>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every((id) => typeof id === "string" && uuid.test(id)) &&
    new Set(value).size === value.length
  );
}
function selection(value: unknown, scope: ProposalScope, candidates: ReadonlySet<string>): Selection {
  if (!object(value)) throw Error("Invalid proposal receipt");
  if (value.status === "denied" || value.status === "conflict")
    throw Object.assign(Error("Proposal refused"), { status: value.status === "denied" ? 401 : 409 });
  if (
    value.status !== "success" ||
    value.schema_version !== "portal-proposals.v1" ||
    value.publication_id !== scope.publication_id ||
    value.publication_version !== scope.publication_version ||
    !ids(value.retired) ||
    !object(value.selection)
  )
    throw Error("Invalid proposal receipt");
  const result = value.selection;
  if (
    typeof result.version !== "number" ||
    !Number.isSafeInteger(result.version) ||
    result.version < 0 ||
    !ids(result.selected) ||
    !object(result.notes)
  )
    throw Error("Invalid proposal selection");
  const selected = result.selected;
  const retired = value.retired;
  if (
    retired.some((id) => candidates.has(id) || !selected.includes(id)) ||
    selected.some((id) => !candidates.has(id) && !retired.includes(id))
  )
    throw Error("Unknown proposal property");
  const notes: Record<string, string> = Object.create(null);
  for (const [id, note] of Object.entries(result.notes)) {
    if (!selected.includes(id) || typeof note !== "string" || note.length > 2000 || note.includes("\0"))
      throw Error("Invalid proposal note");
    notes[id] = note;
  }
  return {
    version: result.version,
    selected: [...selected],
    notes,
    ...(retired.length ? { retired: [...retired] } : {}),
  };
}
export function proposalSelectionPorts(
  options: {
    scope: ProposalScope;
    properties: readonly TourProperty[];
    transport: ProposalTransport;
  } & Pick<SelectionPorts, "signOut" | "clearPrivateState" | "returnToGate">,
): SelectionPorts {
  const scope = Object.freeze({ ...options.scope });
  if (
    !uuid.test(scope.publication_id) ||
    !Number.isSafeInteger(scope.publication_version) ||
    scope.publication_version < 1
  )
    throw Error("Invalid publication scope");
  const candidates = new Set(options.properties.filter((p) => p.role === "candidate").map((p) => p.id));
  return {
    read: async (options_) => selection(await options.transport.read(options_), scope, candidates),
    save: async (request, options_) => {
      if (request.selected.some((id) => !candidates.has(id)))
        throw Object.assign(Error("Remove retired properties before saving"), { status: 409 });
      return selection(await options.transport.save(scope.publication_version, request, options_), scope, candidates);
    },
    signOut: options.signOut,
    clearPrivateState: options.clearPrivateState,
    returnToGate: options.returnToGate,
  };
}
