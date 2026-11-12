import type { Publication, Request } from "./client-publication-contract.ts";
import { publicationContract } from "./client-publication-contract.ts";
export function createPublicationFixture(): Request {
  const initial: Publication = {
    id: "33333333-3333-4333-8333-333333333333",
    kind: "milestone",
    title: "Site visit scheduled",
    content: "We will review the shortlist together.",
    published: false,
    version: 1,
  };
  const byDeal = new Map<string, Map<string, Publication>>();
  const receipts = new Map<string, unknown>();
  return async (name, args) => {
    if (!("deal_id" in args) || typeof args.deal_id !== "string") throw Error("Invalid deal");
    let publications = byDeal.get(args.deal_id);
    if (!publications) {
      publications = new Map([[initial.id, { ...initial }]]);
      byDeal.set(args.deal_id, publications);
    }
    const envelope = { ok: true, schema_version: publicationContract.schema };
    if (name === "list-deal-deliverables")
      return { ok: true, schema_version: "deal-deliverables.v1", deliverables: [] };
    if (name === "list-deal-client-publications") return { ...envelope, publications: [...publications.values()] };
    if (name === "preview-deal-client-view")
      return {
        ...envelope,
        portal: {
          slug: "synthetic-client",
          roadmap: { current_phase: null, phases: [] },
          materials: [],
          publications: [...publications.values()]
            .filter((p) => p.published && p.kind !== "deliverable")
            .map((p) => ({
              id: p.id,
              kind: p.kind,
              title: p.title,
              ...("content" in p ? { content: p.content } : {}),
            })),
        },
      };
    if (name !== "set-client-publication" || !("idempotency_key" in args) || typeof args.idempotency_key !== "string")
      throw Error("Invalid command");
    if (receipts.has(args.idempotency_key)) return receipts.get(args.idempotency_key);
    if (
      !("publication_id" in args) ||
      typeof args.publication_id !== "string" ||
      !("base_version" in args) ||
      typeof args.base_version !== "number" ||
      !("title" in args) ||
      typeof args.title !== "string" ||
      !("content" in args) ||
      typeof args.content !== "string" ||
      !("published" in args) ||
      typeof args.published !== "boolean" ||
      !("kind" in args) ||
      !["milestone", "document", "report", "tour"].includes(String(args.kind))
    )
      throw Error("Invalid fixture command");
    const existing = publications.get(args.publication_id);
    if ((existing?.version ?? 0) !== args.base_version) throw Error("publication_version_conflict");
    const kind = args.kind;
    if (kind !== "milestone" && kind !== "document" && kind !== "tour" && kind !== "report")
      throw Error("Invalid kind");
    const row: Publication = {
      id: args.publication_id,
      version: args.base_version + 1,
      published: args.published,
      title: args.title,
      kind,
      content: args.content,
    };
    publications.set(row.id, row);
    const result = { ...envelope, publication: { id: row.id, version: row.version, published: row.published } };
    receipts.set(args.idempotency_key, result);
    return result;
  };
}
