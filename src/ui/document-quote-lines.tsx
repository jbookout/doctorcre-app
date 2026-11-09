import { useState } from "react";
import { type CompleteLine, type QuoteFragment, type QuoteSource, quoteBlock, selectLines } from "./document-quote";
import { type QuoteAskClient, QuoteNextAsk } from "./document-quote-next-ask";

export function QuoteLines({
  source,
  fragments,
  client,
}: {
  source: QuoteSource;
  fragments: QuoteFragment[];
  client: QuoteAskClient | null;
}) {
  const [range, setRange] = useState<{ page: number; start: number; end: number } | null>(null);
  const [comment, setComment] = useState("");
  const lines: CompleteLine[] = fragments.filter((line) => line.offset === 0 && line.end_of_line);
  let block: string | null = null;
  let error = "";
  try {
    if (range)
      block = quoteBlock(
        source,
        range.page,
        range.start,
        range.end,
        selectLines(lines, range.page, range.start, range.end),
        comment,
      );
  } catch (reason) {
    error = reason instanceof Error ? reason.message : "Select complete lines.";
  }
  function select(page: number, start: number, end: number) {
    setRange({ page, start, end });
    setComment("");
  }
  return (
    <section aria-label="Select document excerpt" style={{ minWidth: 0 }}>
      {[...new Set(fragments.map((line) => line.page))].map((page) => (
        <section key={page} aria-label={`Page ${page}`}>
          <h4>Page {page}</h4>
          {fragments
            .filter((line) => line.page === page)
            .map((line) => {
              const complete = line.offset === 0 && line.end_of_line;
              const eligible = complete && Array.from(line.text).length <= 4000;
              return (
                <div
                  key={`${line.page}:${line.line}:${line.offset}`}
                  data-text-page={page}
                  data-text-line={line.line}
                  data-text-offset={line.offset}
                  data-line-complete={complete}
                >
                  <span>
                    Line {line.line}
                    {!complete ? " (continues)" : ""}
                  </span>
                  <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "0 0 1rem" }}>
                    {line.text}
                  </pre>
                  <button
                    className="btn"
                    type="button"
                    disabled={!eligible}
                    aria-pressed={range?.page === page && line.line >= range.start && line.line <= range.end}
                    onClick={() => select(page, line.line, line.line)}
                  >
                    Select line {line.line}
                  </button>
                  {range?.page === page && (
                    <>
                      <button
                        className="btn"
                        type="button"
                        disabled={!eligible || line.line > range.end}
                        onClick={() => select(page, line.line, range.end)}
                      >
                        Start at line {line.line}
                      </button>
                      <button
                        className="btn"
                        type="button"
                        disabled={!eligible || line.line < range.start}
                        onClick={() => select(page, range.start, line.line)}
                      >
                        End at line {line.line}
                      </button>
                    </>
                  )}
                </div>
              );
            })}
        </section>
      ))}
      {range && (
        <>
          <p>
            Extracted page {range.page}, lines {range.start}-{range.end}
          </p>
          <label>
            Comment on excerpt
            <textarea value={comment} rows={3} onChange={(event) => setComment(event.target.value)} />
          </label>
          {error && <p role="status">{error}</p>}
          {block && (
            <section aria-label="Excerpt preview">
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{block}</pre>
            </section>
          )}
        </>
      )}
      {client ? (
        <QuoteNextAsk client={client} block={block} />
      ) : (
        <p>Open a signed-in Dr. CRE conversation to use excerpts in an ask.</p>
      )}
    </section>
  );
}
