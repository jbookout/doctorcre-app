import { createRoot } from "react-dom/client";
import type { IntakeState } from "./share-intake-model.ts";
import { createShareIntake } from "./share-intake-model.ts";

export function mountShareIntake(element: Element, options: Parameters<typeof createShareIntake>[0]) {
  const root = createRoot(element);
  let state: IntakeState = { kind: "receiving" };
  const model = createShareIntake({
    ...options,
    changed(next) {
      state = next;
      options.changed(next);
      render();
    },
  });
  function render() {
    root.render(
      <section aria-label="Share a file" className="share-intake">
        <p className="eyebrow">Deal documents</p>
        <h1>File this share</h1>
        <p>Choose a deal for one PDF or photo. Pending files expire after ten minutes.</p>
        {"filename" in state && <h2>{state.filename}</h2>}
        <div role="status" aria-live="polite">
          {state.kind === "receiving" && <p>Checking your session and shared file…</p>}
          {state.kind === "choosing" && (
            <label>
              Choose from available deals
              <select defaultValue="" onChange={(event) => model.choose(event.target.value)}>
                <option disabled value="">
                  Select a deal
                </option>
                {state.deals.map((deal) => (
                  <option key={deal.id} value={deal.id}>
                    {deal.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {state.kind === "ready" && (
            <>
              <p>File in {state.deal.name}</p>
              <button type="button" onClick={() => void model.file()}>
                File document
              </button>
            </>
          )}
          {state.kind === "filing" && <p>Filing in {state.deal.name}. Keep this page open.</p>}
          {state.kind === "uncertain" && (
            <>
              <p>{state.message}</p>
              <p>The destination stays {state.deal.name} until reconciled.</p>
              <button type="button" onClick={() => void model.file()}>
                Reconcile filing
              </button>
            </>
          )}
          {state.kind === "filed" && (
            <>
              <h2>Filed</h2>
              <p>{state.attachment.filename} is confirmed in this deal’s document list.</p>
              <a href={`/deals?deal=${state.attachment.deal_id}`}>Open deal</a>
              <details>
                <summary>Attachment receipt</summary>
                <p>{state.attachment.attachment_id}</p>
                <p>{state.attachment.sha256}</p>
              </details>
            </>
          )}
          {(state.kind === "refused" || state.kind === "retired") && <p>{state.message}</p>}
        </div>
        {["choosing", "ready", "uncertain"].includes(state.kind) && (
          <button type="button" onClick={() => void model.discard()}>
            Discard file
          </button>
        )}
        <p>
          <a href="/">Back to workspace</a>
        </p>
      </section>,
    );
  }
  render();
  void model.start();
  return {
    dispose() {
      model.retire();
      root.unmount();
    },
    retire: model.retire,
  };
}

const element = typeof document === "undefined" ? null : document.querySelector("#shareIntake");
if (element) {
  const refused = new URL(location.href).searchParams.get("refused");
  if (refused) {
    const p = document.createElement("p");
    p.textContent =
      refused === "busy"
        ? "Another share is already pending. This file was refused. Return to the pending file to finish or discard it."
        : "This share was refused. Sign in and share one supported PDF or photo, up to 25 MiB.";
    const a = document.createElement("a");
    a.href = "/share-intake.html";
    a.textContent = "Return to pending share";
    element.replaceChildren(p, a);
  } else {
    const view = mountShareIntake(element, {
      fetcher: fetch.bind(globalThis),
      changed() {},
      async handoff(csrf, action, operation) {
        const worker = navigator.serviceWorker?.controller;
        if (!worker) throw Error("Share worker unavailable. Share the file again.");
        return new Promise((resolve, reject) => {
          const channel = new MessageChannel();
          // eslint-disable-next-line no-restricted-syntax -- One message deadline closes the channel after ten seconds without retrying.
          const timer = setTimeout(() => {
            channel.port1.close();
            reject(Error("Share custody unavailable. Try again."));
          }, 10000);
          channel.port1.onmessage = (event) => {
            clearTimeout(timer);
            channel.port1.close();
            resolve(event.data);
          };
          worker.postMessage({ type: "doctorcre-share", csrf, action, operation }, [channel.port2]);
        });
      },
    });
    window.addEventListener("doctorcre-session-invalidated", () => view.retire());
    const invalidated = (event: StorageEvent) => {
      if (event.key === "doctorcre-session-epoch-v1") view.retire();
    };
    window.addEventListener("storage", invalidated);
    window.addEventListener(
      "pagehide",
      () => {
        window.removeEventListener("storage", invalidated);
        view.dispose();
      },
      { once: true },
    );
  }
}
