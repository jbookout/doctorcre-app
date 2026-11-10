import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { type AskRequest, createAskOutbox, type QueuedAsk } from "./queued-asks";

export type AskComposerClient = {
  askSession(): Promise<{ actor: string }>;
  submitDocRequest(request: AskRequest, actor: string): Promise<unknown>;
};
const labels: Record<QueuedAsk["kind"], string> = {
  queued: "Saved on this device. Waiting for a connection.",
  submitting: "Sending your ask…",
  unknown: "Receipt not confirmed. Your ask is kept here.",
  refused: "Your ask was declined. It is kept here.",
  accepted: "Received by Dr. CRE. An answer is still pending.",
};
function Composer({
  box,
  isClosed,
  onReady,
  onUpdate,
}: {
  box: ReturnType<typeof createAskOutbox>;
  isClosed(): boolean;
  onReady: ((insert: ((block: string) => Promise<void>) | null) => void) | undefined;
  onUpdate(handler: () => void): void;
}) {
  const [text, setText] = useState(() => box.draft());
  const [inserting, setInserting] = useState(false);
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const currentText = useRef(text);
  currentText.current = text;
  useEffect(() => {
    onReady?.(async (block) => {
      if (isClosed()) throw Error("This conversation is closed.");
      setInserting(true);
      try {
        const next = await box.appendDraft(block, currentText.current);
        if (isClosed()) return;
        currentText.current = next;
        setText(next);
        setNotice("Excerpt inserted. Review your ask before sending.");
        flushSync(() => setInserting(false));
        input.current?.focus();
      } finally {
        setInserting(false);
      }
    });
    return () => onReady?.(null);
  }, [box, isClosed, onReady]);
  const [, update] = useState(0);
  onUpdate(() => update((n) => n + 1));
  const run = (action: () => void | Promise<void>) => {
    try {
      Promise.resolve(action()).catch(() =>
        setNotice("Device storage is unavailable. Your ask has not been confirmed."),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Your ask could not be saved.");
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        run(async () => {
          const submitted = currentText.current;
          await box.enqueue(submitted);
          if (isClosed()) return;
          if (currentText.current === submitted) {
            currentText.current = box.draft();
            setText(currentText.current);
          }
          setNotice("");
          return box.flush();
        });
      }}
    >
      <div className="field">
        <label htmlFor="askText">Ask Dr. CRE</label>
        <textarea
          ref={input}
          id="askText"
          rows={3}
          maxLength={20000}
          value={text}
          disabled={inserting}
          aria-describedby="askHelp askNotice"
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            currentText.current = next;
            void box
              .saveDraft(next)
              .then(() => {
                if (isClosed()) return;
                setNotice("");
              })
              .catch(() => {
                if (!isClosed()) setNotice("This text is only on this page. Device storage is unavailable.");
              });
          }}
        />
      </div>
      <p id="askHelp" className="caption">
        Saved asks send when you reconnect. You can keep working while an answer is pending.
      </p>
      <button type="submit" className="btn" disabled={inserting || !text.trim()}>
        Send ask
      </button>
      <p id="askNotice" role="status">
        {notice}
      </p>
      <ul className="work-list" aria-label="Your asks" aria-live="polite">
        {box.entries().map((row) => (
          <li key={row.request.idempotency_key}>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.request.body}</p>
            <p>{labels[row.kind]}</p>
            {(row.kind === "unknown" || row.kind === "refused") && (
              <button
                type="button"
                className="btn"
                // eslint-disable-next-line no-restricted-syntax -- Single explicit click retries one frozen request.
                onClick={() => run(() => box.retry(row.request.idempotency_key))}
              >
                {row.kind === "unknown" ? "Check receipt" : "Try again"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </form>
  );
}

export async function mountAskComposer(
  host: HTMLElement,
  client: AskComposerClient,
  conversation: string,
  onReady?: (insert: ((block: string) => Promise<void>) | null) => void,
) {
  let closed = false,
    started = false,
    starting = false;
  const root = createRoot(host);
  let stop = () => {};
  const dispose = () => {
    closed = true;
    onReady?.(null);
    window.removeEventListener("online", restart);
    stop();
    root.unmount();
  };
  const unavailable = () =>
    flushSync(() => root.render(<p role="status">Reconnect and sign in to open your saved asks.</p>));
  async function start() {
    if (started || starting || closed) return;
    starting = true;
    flushSync(() => root.render(<p role="status">Verifying your session to open saved asks…</p>));
    try {
      const { actor } = await client.askSession();
      if (closed) return;
      let redraw = () => {};
      const box = createAskOutbox({
        storage: window.localStorage,
        actor,
        conversation,
        online: () => navigator.onLine,
        uuid: () => crypto.randomUUID(),
        submit: (request) => client.submitDocRequest(request, actor),
        changed: () => redraw(),
      });
      stop = box.stop;
      flushSync(() =>
        root.render(
          <Composer
            box={box}
            isClosed={() => closed}
            onReady={onReady}
            onUpdate={(handler) => {
              redraw = handler;
            }}
          />,
        ),
      );
      started = true;
      window.removeEventListener("online", restart);
      const reconnect = () => {
        box.flush().catch(() => {});
      };
      const storage = () => redraw();
      // eslint-disable-next-line no-restricted-syntax -- Reconnect attempts each saved ask once, with no timer or recursive retry.
      window.addEventListener("online", reconnect);
      window.addEventListener("storage", storage);
      stop = () => {
        box.stop();
        window.removeEventListener("online", reconnect);
        window.removeEventListener("storage", storage);
      };
      // eslint-disable-next-line no-restricted-syntax -- Single initial mount attempts one finite snapshot of saved asks.
      reconnect();
    } catch {
      if (!closed) unavailable();
    } finally {
      starting = false;
    }
  }
  const restart = () => {
    if (!closed) void start();
  };
  // eslint-disable-next-line no-restricted-syntax -- Reconnect verifies the session until startup succeeds or the composer closes.
  window.addEventListener("online", restart);
  window.addEventListener("doctorcre-session-invalidated", dispose, { once: true });
  await start();
  return () => {
    window.removeEventListener("online", restart);
    window.removeEventListener("doctorcre-session-invalidated", dispose);
    if (!closed) dispose();
  };
}
