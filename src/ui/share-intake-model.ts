import type { Attachment, Material } from "./share-contract.ts";
import { parseAttachment, parseReservation, validateSharedFile } from "./share-contract.ts";

type Deal = { id: string; name: string };
type Operation = { deal: string; reservation: string | null; uploadPath: string | null };
type Share = {
  id: string;
  file: File;
  expires: number;
  keys: { reserve: string; finalize: string; abandon: string };
  operation: Operation | null;
};
export type IntakeState =
  | { kind: "receiving" }
  | { kind: "choosing"; filename: string; deals: Deal[] }
  | { kind: "ready"; filename: string; deal: Deal }
  | { kind: "filing"; filename: string; deal: Deal }
  | { kind: "uncertain"; filename: string; deal: Deal; message: string }
  | { kind: "filed"; attachment: Attachment }
  | { kind: "refused" | "retired"; message: string };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function createShareIntake({
  fetcher,
  handoff,
  changed,
}: {
  fetcher: typeof fetch;
  handoff(csrf: string, action: "read" | "operation" | "clear", operation?: Operation): Promise<unknown>;
  changed(state: IntakeState): void;
}) {
  let state: IntakeState = { kind: "receiving" };
  let share: Share | null = null,
    token: string | null = null,
    deals: Deal[] = [],
    selected: Deal | null = null;
  const lifetime = new AbortController();
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const set = (next: IntakeState) => {
    if (!lifetime.signal.aborted) {
      state = next;
      changed(next);
    }
  };
  function retire(message = "Session ended. Sign in and share the file again.") {
    lifetime.abort();
    clearTimeout(expiry);
    share = null;
    token = null;
    deals = [];
    selected = null;
    state = { kind: "retired", message };
    changed(state);
  }
  async function session() {
    lifetime.signal.throwIfAborted();
    const response = await fetcher("/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)]),
    });
    if (response.status === 401 || response.status === 403) {
      retire();
      throw Error("Session ended");
    }
    const value: unknown = await response.json();
    if (
      !response.ok ||
      !record(value) ||
      !record(value.actor) ||
      typeof value.actor.slug !== "string" ||
      typeof value.csrf_token !== "string" ||
      !value.csrf_token
    )
      throw Error("Session unavailable");
    if (token && token !== value.csrf_token) {
      retire();
      throw Error("Session changed");
    }
    token = value.csrf_token;
    return token;
  }
  async function request(path: string, method = "GET", body?: BodyInit) {
    const csrf = await session();
    const response = await fetcher(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
      headers: {
        accept: "application/json",
        ...(method === "GET"
          ? {}
          : {
              "x-carr-csrf": csrf,
              "content-type": method === "PUT" ? "application/octet-stream" : "application/json",
            }),
      },
      ...(body === undefined ? {} : { body }),
    });
    if (response.status === 401 || response.status === 403) {
      retire();
      throw Error("Session ended");
    }
    const value: unknown = await response.json();
    await session();
    if (!response.ok) throw Error("Request refused or unavailable. Reconcile before trying again.");
    return value;
  }
  async function rpc(name: string, args: object) {
    const value = await request(
      "/mcp",
      "POST",
      JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    );
    if (!record(value) || !record(value.result) || value.result.isError || !Array.isArray(value.result.content))
      throw Error("Deal read unavailable");
    const text = value.result.content.find((v: unknown) => record(v) && v.type === "text");
    if (!record(text) || typeof text.text !== "string") throw Error("Deal read unavailable");
    const result: unknown = JSON.parse(text.text);
    return result;
  }
  async function board() {
    const value = await rpc("deal-room-board", { workspace: "all" });
    if (!record(value) || !Array.isArray(value.deals) || value.deals.length > 1000)
      throw Error("Deal choices unavailable");
    return value.deals.map((row: unknown): Deal => {
      if (!record(row) || typeof row.id !== "string" || !uuid.test(row.id) || typeof row.name !== "string" || !row.name)
        throw Error("Invalid deal choice");
      return { id: row.id, name: row.name };
    });
  }
  async function clear() {
    const result = await handoff(await session(), "clear");
    if (!record(result) || result.ok !== true) throw Error("Share cleanup unavailable. Reconcile before continuing.");
  }
  async function save(active: Share, operation: Operation) {
    const value = await handoff(await session(), "operation", operation);
    if (!record(value) || value.ok !== true) throw Error("Share custody unavailable");
    active.operation = operation;
  }
  async function material(active: Share, deal: Deal): Promise<Material> {
    const hash = await crypto.subtle.digest("SHA-256", await active.file.arrayBuffer());
    return {
      deal_id: deal.id,
      filename: active.file.name,
      mime: active.file.type,
      bytes: active.file.size,
      sha256: [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, "0")).join(""),
    };
  }
  async function reserve(active: Share, deal: Deal, expected: Material) {
    await save(active, { deal: deal.id, reservation: null, uploadPath: null });
    const value = await request(
      `/api/v1/deal-deliverables/${deal.id}`,
      "POST",
      JSON.stringify({
        target_collection: "documents",
        filename: expected.filename,
        mime: expected.mime,
        bytes: expected.bytes,
        sha256: expected.sha256,
        idempotency_key: active.keys.reserve,
      }),
    );
    const result = parseReservation(value, deal.id);
    const operation = { deal: deal.id, reservation: result.id, uploadPath: result.uploadPath };
    await save(active, operation);
    return operation;
  }
  async function showReceipt(value: unknown, expected: Material) {
    const attachment = parseAttachment(value, expected);
    let cursor: string | undefined;
    const cursors = new Set<string>();
    // eslint-disable-next-line no-restricted-syntax -- Receipt readback stops after ten pages of fifty documents; this is not polling.
    for (let page = 0; page < 10; page++) {
      const listed = await rpc("list-deal-documents", {
        deal_id: expected.deal_id,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      if (
        !record(listed) ||
        listed.ok !== true ||
        listed.schema_version !== "deal-documents.v1" ||
        !Array.isArray(listed.documents)
      )
        throw Error("Document readback unavailable");
      if (
        listed.documents.some(
          (row: unknown) =>
            record(row) &&
            row.id === attachment.attachment_id &&
            row.content_hash === expected.sha256 &&
            row.display_name === expected.filename,
        )
      ) {
        await clear();
        share = null;
        clearTimeout(expiry);
        set({ kind: "filed", attachment });
        return;
      }
      if (!listed.has_more || typeof listed.next_cursor !== "string" || cursors.has(listed.next_cursor)) break;
      cursor = listed.next_cursor;
      cursors.add(cursor);
    }
    throw Error("Receipt received. Document list confirmation unavailable. Retry reconciliation.");
  }
  async function run(discard = false) {
    if (!share || !selected || !["ready", "uncertain"].includes(state.kind)) return;
    const active = share,
      deal = selected;
    set({ kind: "filing", filename: active.file.name, deal });
    try {
      const fresh = await board();
      if (!fresh.some((row) => row.id === deal.id)) throw Error("The selected deal is no longer available.");
      const expected = await material(active, deal);
      const operation = active.operation?.reservation ? active.operation : await reserve(active, deal, expected);
      const base = `/api/v1/deal-deliverables/${deal.id}/${operation.reservation}`;
      const receipt = await request(`${base}/receipt`);
      if (
        !record(receipt) ||
        receipt.ok !== true ||
        !record(receipt.deliverable) ||
        receipt.deliverable.deal_id !== deal.id ||
        receipt.deliverable.id !== operation.reservation
      )
        throw Error("Receipt unavailable");
      if (receipt.deliverable.state === "finalized") {
        await showReceipt(receipt, expected);
        return;
      }
      if (discard) {
        const abandoned = await request(
          `${base}/abandon`,
          "POST",
          JSON.stringify({ idempotency_key: active.keys.abandon }),
        );
        if (
          !record(abandoned) ||
          abandoned.ok !== true ||
          !record(abandoned.deliverable) ||
          abandoned.deliverable.state !== "expired" ||
          abandoned.deliverable.id !== operation.reservation
        )
          throw Error("Discard receipt unavailable");
        await clear();
        retire("File discarded.");
        return;
      }
      if (receipt.deliverable.state === "started") {
        if (!operation.uploadPath) throw Error("Upload path unavailable");
        const uploaded = await request(operation.uploadPath, "PUT", active.file);
        if (
          !record(uploaded) ||
          uploaded.ok !== true ||
          uploaded.state !== "verified" ||
          uploaded.deliverable_id !== operation.reservation ||
          uploaded.sha256 !== expected.sha256 ||
          uploaded.bytes !== expected.bytes ||
          uploaded.mime !== expected.mime
        )
          throw Error("Byte verification unavailable");
      } else if (receipt.deliverable.state !== "verified") throw Error("Upload expired or unavailable");
      await showReceipt(
        await request(`${base}/finalize`, "POST", JSON.stringify({ idempotency_key: active.keys.finalize })),
        expected,
      );
    } catch (error) {
      set({
        kind: "uncertain",
        filename: active.file.name,
        deal,
        message: error instanceof Error ? error.message : "Receipt unavailable. Retry reconciliation.",
      });
    }
  }
  return {
    async start() {
      try {
        const value = await handoff(await session(), "read");
        lifetime.signal.throwIfAborted();
        if (!record(value) || value.ok !== true || !record(value.share))
          throw Error(record(value) && typeof value.error === "string" ? value.error : "Share unavailable");
        const row = value.share;
        if (
          !(row.file instanceof File) ||
          typeof row.id !== "string" ||
          typeof row.expires !== "number" ||
          row.expires <= Date.now() ||
          row.expires > Date.now() + 600000 ||
          !record(row.keys) ||
          typeof row.keys.reserve !== "string" ||
          !uuid.test(row.keys.reserve) ||
          typeof row.keys.finalize !== "string" ||
          !uuid.test(row.keys.finalize) ||
          typeof row.keys.abandon !== "string" ||
          !uuid.test(row.keys.abandon)
        )
          throw Error("Invalid share");
        validateSharedFile(row.file);
        let operation: Operation | null = null;
        if (row.operation !== null) {
          if (
            !record(row.operation) ||
            typeof row.operation.deal !== "string" ||
            !uuid.test(row.operation.deal) ||
            !(
              row.operation.reservation === null ||
              (typeof row.operation.reservation === "string" && uuid.test(row.operation.reservation))
            ) ||
            !(
              row.operation.uploadPath === null ||
              (typeof row.operation.uploadPath === "string" &&
                row.operation.uploadPath ===
                  `/api/v1/deal-deliverables/${row.operation.deal}/${row.operation.reservation}/bytes`)
            )
          )
            throw Error("Invalid operation");
          operation = {
            deal: row.operation.deal,
            reservation: row.operation.reservation,
            uploadPath: row.operation.uploadPath,
          };
        }
        share = {
          id: row.id,
          file: row.file,
          expires: row.expires,
          keys: { reserve: row.keys.reserve, finalize: row.keys.finalize, abandon: row.keys.abandon },
          operation,
        };
        // eslint-disable-next-line no-restricted-syntax -- Single expiry timer retires private bytes after the validated ten-minute share deadline.
        expiry = setTimeout(() => retire("Share expired. Share the file again."), row.expires - Date.now());
        deals = await board();
        if (operation) {
          selected = deals.find((row) => row.id === operation.deal) ?? null;
          if (!selected) throw Error("Original deal unavailable.");
          set({
            kind: "uncertain",
            filename: share.file.name,
            deal: selected,
            message: "Reconcile the previous filing before continuing.",
          });
        } else set({ kind: "choosing", filename: share.file.name, deals });
      } catch (error) {
        share = null;
        set({ kind: "refused", message: error instanceof Error ? error.message : "Share unavailable" });
      }
    },
    choose(id: string) {
      if (!share || share.operation || !["choosing", "ready"].includes(state.kind)) return;
      const deal = deals.find((row) => row.id === id);
      if (!deal) {
        set({ kind: "refused", message: "Choose an exact available deal." });
        return;
      }
      selected = deal;
      set({ kind: "ready", filename: share.file.name, deal });
    },
    file: () => run(),
    async discard() {
      if (!share || state.kind === "filing") return;
      if (share.operation) return run(true);
      try {
        await clear();
        retire("File discarded.");
      } catch {
        retire("Share could not be cleared. It expires within ten minutes.");
      }
    },
    retire,
  };
}
