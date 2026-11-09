import { useEffect, useRef, useState } from "react";
import { type AskComposerClient, mountAskComposer } from "./ask-composer";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function conversations(value: unknown) {
  if (
    !record(value) ||
    value.ok !== true ||
    !Array.isArray(value.conversations) ||
    value.conversations.length > 25 ||
    typeof value.more !== "boolean" ||
    (value.more ? typeof value.next_cursor !== "string" || !value.next_cursor : value.next_cursor !== null)
  )
    throw Error("Invalid conversations response.");
  const rows = value.conversations.map((row: unknown) => {
    if (!record(row) || typeof row.id !== "string" || !uuid.test(row.id) || typeof row.title !== "string")
      throw Error("Invalid conversation.");
    return { id: row.id, title: row.title };
  });
  return { rows, cursor: typeof value.next_cursor === "string" ? value.next_cursor : null };
}

export type QuoteAskClient = AskComposerClient & {
  listDocConversations(args: { limit: number; cursor?: string }, options: { signal: AbortSignal }): Promise<unknown>;
  readDocConversation(
    args: { conversation_id: string; limit: number },
    options: { signal: AbortSignal },
  ): Promise<unknown>;
};
export function QuoteNextAsk({ client, block }: { client: QuoteAskClient; block: string | null }) {
  const [rows, setRows] = useState<{ id: string; title: string }[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [inserted, setInserted] = useState<string | null>(null);
  const [inserting, setInserting] = useState(false);
  const [loading, setLoading] = useState(false);
  const insert = useRef<((block: string) => Promise<void>) | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const request = useRef({ retired: false, busy: false, controller: new AbortController() });
  const used = useRef<string | null>(null);
  const latest = useRef(block);
  latest.current = block;
  useEffect(() => {
    const retire = () => {
      request.current.retired = true;
      request.current.controller.abort();
      insert.current = null;
      setReady(false);
      setRows([]);
      setDestination("");
    };
    window.addEventListener("doctorcre-session-invalidated", retire);
    return () => {
      retire();
      window.removeEventListener("doctorcre-session-invalidated", retire);
    };
  }, []);
  useEffect(() => {
    insert.current = null;
    setReady(false);
    if (!destination || !host.current || request.current.retired) return;
    let active = true;
    let dispose: (() => void) | undefined;
    const slot = document.createElement("div");
    host.current.replaceChildren(slot);
    const controller = new AbortController();
    void (async () => {
      try {
        const value = await client.readDocConversation(
          { conversation_id: destination, limit: 1 },
          { signal: controller.signal },
        );
        if (!active || request.current.retired) return;
        if (
          !record(value) ||
          value.ok !== true ||
          !record(value.identity) ||
          value.identity.id !== destination ||
          !Array.isArray(value.turns) ||
          !Array.isArray(value.effective_grants)
        )
          throw Error("Conversation unavailable.");
        const close = await mountAskComposer(slot, client, destination, (handler) => {
          if (active && !request.current.retired) {
            insert.current = handler;
            setReady(handler !== null);
          }
        });
        if (!active || request.current.retired) close();
        else dispose = close;
      } catch {
        if (active) setNotice("Conversation unavailable. Choose it again to retry.");
      }
    })();
    return () => {
      active = false;
      controller.abort();
      insert.current = null;
      dispose?.();
      slot.remove();
    };
  }, [client, destination]);
  async function load() {
    const current = request.current;
    if (current.retired || current.busy) return;
    current.busy = true;
    setLoading(true);
    try {
      const value = await client.listDocConversations(
        { limit: 25, ...(cursor ? { cursor } : {}) },
        { signal: current.controller.signal },
      );
      if (current.retired) return;
      const parsed = conversations(value);
      const nextRows = parsed.rows;
      setRows((previous) => (cursor ? [...previous, ...nextRows] : nextRows));
      if (parsed.cursor && parsed.cursor === cursor) throw Error("Nonadvancing conversation cursor.");
      setCursor(parsed.cursor);
      setNotice(
        nextRows.length
          ? "Choose the conversation for your next Dr. CRE ask."
          : "No conversations available. Open Conversations to create one first.",
      );
    } catch {
      if (!current.retired) setNotice("Conversations could not be read. Try again.");
    } finally {
      current.busy = false;
      setLoading(false);
    }
  }
  return (
    <section aria-label="Next Dr. CRE ask">
      <button className="btn" type="button" disabled={loading || request.current.retired} onClick={() => void load()}>
        {cursor ? "More conversations" : "Choose conversation"}
      </button>
      <a href="/conversations">Open Conversations</a>
      {rows.length > 0 && (
        <label className="field">
          Conversation for next ask
          <select
            style={{ maxWidth: "100%", borderColor: "var(--fg-quiet)" }}
            value={destination}
            onChange={(event) => {
              insert.current = null;
              setReady(false);
              setDestination(event.target.value);
              used.current = null;
              setInserted(null);
            }}
          >
            <option value="">Choose a conversation</option>
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        className="btn"
        type="button"
        disabled={inserting || !ready || !block || inserted === block}
        onClick={async () => {
          if (
            !block ||
            latest.current !== block ||
            !insert.current ||
            used.current === block ||
            request.current.retired
          )
            return;
          const handler = insert.current;
          used.current = block;
          setInserting(true);
          try {
            await handler(block);
            if (request.current.retired || insert.current !== handler) return;
            setInserted(block);
            setNotice("Excerpt inserted. Review your ask before sending.");
          } catch (error) {
            used.current = null;
            if (request.current.retired || insert.current !== handler) return;
            setNotice(error instanceof Error ? error.message : "The excerpt could not be inserted.");
          } finally {
            setInserting(false);
          }
        }}
      >
        Use in next ask
      </button>
      <p role="status">{notice}</p>
      <div ref={host} />
    </section>
  );
}
