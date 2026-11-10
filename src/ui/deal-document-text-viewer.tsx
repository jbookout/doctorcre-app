import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentTextClient, TextChunk, TextIdentity, TextPosition, TextRequest } from "./deal-document-text";
import { parseDocumentText } from "./deal-document-text";
import { joinQuoteContinuation, type QuoteFragment } from "./document-quote";
import { QuoteLines } from "./document-quote-lines";
import type { QuoteAskClient } from "./document-quote-next-ask";

type Source = TextIdentity & { filename: string };
type State =
  | { kind: "loading" | "unavailable" | "source_changed" | "expired" | "no_text" | "not_ready" | "unsupported" }
  | { kind: "ready"; chunk: Extract<TextChunk, { status: "produced" }> };
export function DocumentTextViewer({
  source,
  client,
  onClose,
  quoteClient,
}: {
  source: Source;
  client: DocumentTextClient;
  onClose(): void;
  quoteClient: QuoteAskClient | null;
}) {
  const initial = useRef({ source, client });
  const [state, setState] = useState<State>({ kind: "loading" });
  const [pageInput, setPageInput] = useState("1");
  const request = useRef<{ generation: number; controller: AbortController | null; retired: boolean; busy: boolean }>({
    generation: 0,
    controller: null,
    retired: false,
    busy: false,
  });
  const retry = useRef<TextRequest>(source);
  const tail = useRef<QuoteFragment | null>(null);
  const textHash = useRef<string | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const invalidate = useCallback(() => {
    request.current.generation++;
    request.current.controller?.abort();
    request.current.controller = null;
    request.current.busy = false;
    textHash.current = undefined;
    tail.current = null;
  }, []);
  const load = useCallback(
    async (position?: TextPosition) => {
      const { source, client } = initial.current;
      const current = request.current;
      if (current.retired || current.busy) return;
      const args: TextRequest = {
        deal_id: source.deal_id,
        attachment_id: source.attachment_id,
        content_hash: source.content_hash,
        ...position,
      };
      retry.current = args;
      const generation = ++current.generation;
      const controller = new AbortController();
      current.controller = controller;
      current.busy = true;
      setState({ kind: "loading" });
      try {
        const value = await client.readDealDocumentText(args, { signal: controller.signal });
        if (current.retired || generation !== current.generation) return;
        if (typeof value === "object" && value !== null && "error" in value && value.error === "source_changed") {
          invalidate();
          setState({ kind: "source_changed" });
          return;
        }
        const chunk = parseDocumentText(value, args, textHash.current);
        if (chunk.status === "produced") {
          textHash.current = chunk.text_hash;
          setPageInput(String(chunk.lines.at(0)?.page ?? 1));
          const lines = joinQuoteContinuation(tail.current, chunk.lines);
          tail.current = lines.at(-1) ?? null;
          setState({ kind: "ready", chunk: { ...chunk, lines } });
        } else
          setState({
            kind:
              chunk.status === "no_text" ? "no_text" : chunk.reason === "not_produced" ? "not_ready" : "unsupported",
          });
      } catch (error) {
        if (current.retired || generation !== current.generation) return;
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          (error.status === 401 || error.status === 403)
        ) {
          current.retired = true;
          invalidate();
          setState({ kind: "expired" });
        } else if (
          typeof error === "object" &&
          error !== null &&
          (("error" in error && error.error === "source_changed") ||
            ("payload" in error &&
              typeof error.payload === "object" &&
              error.payload !== null &&
              "error" in error.payload &&
              error.payload.error === "source_changed"))
        ) {
          invalidate();
          setState({ kind: "source_changed" });
        } else setState({ kind: "unavailable" });
      } finally {
        if (generation === current.generation) {
          current.busy = false;
          current.controller = null;
        }
      }
    },
    [invalidate],
  );
  useEffect(() => {
    heading.current?.focus();
    const retire = () => {
      request.current.retired = true;
      invalidate();
      setState({ kind: "expired" });
    };
    window.addEventListener("doctorcre-session-invalidated", retire);
    void load();
    return () => {
      request.current.retired = true;
      invalidate();
      window.removeEventListener("doctorcre-session-invalidated", retire);
    };
  }, [invalidate, load]);
  const chunk = state.kind === "ready" ? state.chunk : null;
  return (
    <section aria-label="Document text" className="document-text-viewer">
      <h3 ref={heading} tabIndex={-1} style={{ overflowWrap: "anywhere" }}>
        {state.kind === "expired" ? "Document text" : source.filename}
      </h3>
      <button
        type="button"
        className="btn"
        onClick={() => {
          invalidate();
          onClose();
        }}
      >
        Close document text
      </button>
      <p>
        Extracted text may differ from the original layout. Line numbers refer to extracted lines, including blank
        lines.
      </p>
      <div role="status" aria-live="polite">
        {state.kind === "loading" && <p>Loading document text…</p>}
        {state.kind === "expired" && <p>Session expired. Sign in again to view document text.</p>}
        {state.kind === "source_changed" && (
          <p>The original document changed. Close this viewer, refresh documents and reopen the current file.</p>
        )}
        {state.kind === "unavailable" && <p>Document text could not be read.</p>}
        {state.kind === "not_ready" && <p>Retained text is not ready for this document.</p>}
        {state.kind === "no_text" && <p>This document has no text layer.</p>}
        {state.kind === "unsupported" && <p>Text is unavailable for this file type or extraction limits.</p>}
      </div>
      {["unavailable", "not_ready", "no_text", "unsupported"].includes(state.kind) && (
        <button
          type="button"
          className="btn"
          onClick={() =>
            void load(
              retry.current.page === undefined
                ? undefined
                : { page: retry.current.page, line: retry.current.line ?? 1, offset: retry.current.offset ?? 0 },
            )
          }
        >
          Retry document text
        </button>
      )}
      {chunk && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const page = Number(pageInput);
              if (Number.isInteger(page) && page >= 1 && page <= chunk.page_count)
                void load({ page, line: 1, offset: 0 });
            }}
          >
            <label>
              Page{" "}
              <input
                type="number"
                min={1}
                max={chunk.page_count}
                required
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
              />
            </label>
            <span> of {chunk.page_count}</span>{" "}
            <button className="btn" type="submit">
              Read page
            </button>
          </form>
          <QuoteLines
            key={request.current.generation}
            source={{ ...source, text_hash: chunk.text_hash, text_format_version: chunk.text_format_version }}
            fragments={chunk.lines}
            client={quoteClient}
          />
          {chunk.next && (
            <button
              className="btn"
              type="button"
              onClick={() => {
                if (chunk.next) void load(chunk.next);
              }}
            >
              Read next chunk
            </button>
          )}
        </>
      )}
    </section>
  );
}
