import { useEffect, useEffectEvent, useRef, useState } from "react";
import { parseDeliverableList } from "./deal-deliverable-contract.ts";
import { validateSharedFile } from "./share-contract.ts";
import { createShareIntake, type IntakeState } from "./share-intake-model.ts";

type Rows = ReturnType<typeof parseDeliverableList>;
type Listing = { kind: "loading" } | { kind: "ready"; rows: Rows } | { kind: "failed"; message: string };
type Designation = { kind: "idle" } | { kind: "saving"; id: string } | { kind: "unknown"; message: string };
export function DealDeliverables({ dealId, pending }: { dealId: string; pending(value: boolean): void }) {
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [designation, setDesignation] = useState<Designation>({ kind: "idle" });
  const [upload, setUpload] = useState<IntakeState | null>(null);
  const [failure, setFailure] = useState("");
  const chooser = useRef<HTMLInputElement>(null);
  const model = useRef<ReturnType<typeof createShareIntake> | null>(null);
  const life = useRef(new AbortController());
  const sessionToken = useRef<string | null>(null);
  const active = upload && ["receiving", "choosing", "ready", "filing", "uncertain"].includes(upload.kind);
  async function request(path: string, body?: object) {
    const signal = AbortSignal.any([life.current.signal, AbortSignal.timeout(15000)]);
    const session = await fetch("/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
    });
    const value: unknown = await session.json();
    if (
      !session.ok ||
      !value ||
      typeof value !== "object" ||
      !("csrf_token" in value) ||
      typeof value.csrf_token !== "string"
    )
      throw Error("Sign in again to view deliverables.");
    if (sessionToken.current && sessionToken.current !== value.csrf_token) {
      life.current.abort();
      model.current?.retire();
      throw Error("Session changed. Sign in again.");
    }
    sessionToken.current = value.csrf_token;
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      ...(body
        ? {
            method: "POST",
            headers: { "content-type": "application/json", "x-carr-csrf": value.csrf_token },
            body: JSON.stringify(body),
          }
        : {}),
    });
    if (!response.ok) throw Error("Request unavailable or version changed. Refresh before continuing.");
    const result: unknown = await response.json();
    return result;
  }
  async function refresh() {
    setListing({ kind: "loading" });
    try {
      const rows = parseDeliverableList(await request(`/api/v1/deal-deliverables/${dealId}`), dealId);
      if (!life.current.signal.aborted) {
        setListing({ kind: "ready", rows });
        setDesignation({ kind: "idle" });
      }
    } catch (error) {
      if (!life.current.signal.aborted)
        setListing({ kind: "failed", message: error instanceof Error ? error.message : "Deliverables unavailable" });
    }
  }
  function start(file: File | null) {
    model.current?.close();
    let operation: Parameters<Parameters<typeof createShareIntake>[0]["handoff"]>[2];
    const id = crypto.randomUUID();
    const keys = { reserve: crypto.randomUUID(), finalize: crypto.randomUUID(), abandon: crypto.randomUUID() };
    model.current = createShareIntake({
      fetcher: fetch.bind(globalThis),
      destination: "deliverables",
      journalKey: `doctorcre-deliverable-recovery-v1:${dealId}`,
      async handoff(_csrf, action, next) {
        if (action === "operation") {
          if (next?.deal !== dealId) throw Error("Original deal required");
          operation = next;
        }
        if (action === "clear") file = null;
        return { ok: true, share: { id, file, keys, operation: operation ?? null, expires: Date.now() + 600000 } };
      },
      changed(next) {
        setUpload(next);
        if (next.kind === "choosing") model.current?.choose(dealId);
        if (next.kind === "filed") void refresh();
      },
    });
    setUpload({ kind: "receiving" });
    void model.current.start();
  }
  const initialize = useEffectEvent(() => {
    void refresh();
    if (localStorage.getItem(`doctorcre-deliverable-recovery-v1:${dealId}`)) start(null);
  });
  useEffect(() => {
    life.current = new AbortController();
    initialize();
    function expire() {
      model.current?.retire();
      life.current.abort();
      setListing({ kind: "failed", message: "Session ended. Sign in again." });
    }
    window.addEventListener("doctorcre-session-invalidated", expire);
    return () => {
      life.current.abort();
      model.current?.close();
      window.removeEventListener("doctorcre-session-invalidated", expire);
    };
  }, []);
  useEffect(() => {
    pending(!!active || designation.kind === "saving" || designation.kind === "unknown");
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    if (active) window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active, designation.kind, pending]);
  function choose(files: File[]) {
    if (active || life.current.signal.aborted) return;
    try {
      if (files.length !== 1 || !files[0]) throw Error("Choose one file at a time.");
      validateSharedFile(files[0]);
      setFailure("");
      start(files[0]);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "File refused");
    }
  }
  async function visibility(row: Rows[number]) {
    if (designation.kind !== "idle") return;
    setDesignation({ kind: "saving", id: row.id });
    try {
      await request(`/api/v1/deal-deliverables/${dealId}/${row.id}/visibility`, {
        idempotency_key: crypto.randomUUID(),
        expected_version: row.version,
        visibility: row.visibility === "private" ? "shared" : "private",
      });
      await refresh();
    } catch {
      setDesignation({
        kind: "unknown",
        message: "Designation unconfirmed. Refresh to read the saved version before changing it again.",
      });
    }
  }
  return (
    <section className="deal-deliverables" aria-label="Deal Deliverables">
      <h2>Deliverables</h2>
      <p>
        Partner files for this deal. Uploads start private. Shared files are ready for publication; they are not visible
        to the client.
      </p>
      <button
        type="button"
        className="deliverable-drop"
        disabled={!!active || life.current.signal.aborted}
        onClick={() => chooser.current?.click()}
        tabIndex={0}
        aria-label="Drop a deliverable or choose a file"
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            chooser.current?.click();
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          choose(Array.from(event.dataTransfer.files));
        }}
      >
        <strong>Drop one file here</strong>
        <p>PDF or photo · Up to 25 MiB</p>
      </button>
      <input
        ref={chooser}
        type="file"
        aria-label="Choose a deliverable"
        accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
        disabled={!!active || life.current.signal.aborted}
        onChange={(event) => {
          choose(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <div role="status" aria-live="polite">
        {failure && <p>Failed. {failure}</p>}
        {upload?.kind === "receiving" && <p>Pending. Checking the file and session…</p>}
        {upload && "filename" in upload && <p>{upload.filename}</p>}
        {upload?.kind === "ready" && (
          <>
            <p>Pending in {upload.deal.name}. Private by default.</p>
            <button type="button" className="btn" onClick={() => void model.current?.file()}>
              Upload to this deal
            </button>
          </>
        )}
        {upload?.kind === "filing" && (
          <p>Pending. Uploading and confirming in {upload.deal.name}. Keep this page open.</p>
        )}
        {upload?.kind === "uncertain" && (
          <>
            <p>
              Unknown. {upload.message} The file stays bound to {upload.deal.name}.
            </p>
            <button type="button" className="btn" onClick={() => void model.current?.file()}>
              Reconcile upload
            </button>
          </>
        )}
        {upload?.kind === "filed" && (
          <p>Confirmed. {upload.attachment.filename} is saved in this deal’s Deliverables.</p>
        )}
        {(upload?.kind === "retired" || upload?.kind === "refused") && (
          <p>
            {upload.kind === "refused" ? "Failed" : "Retired"}. {upload.message}
          </p>
        )}
        {upload && ["ready", "uncertain"].includes(upload.kind) && (
          <button type="button" className="btn" onClick={() => void model.current?.discard()}>
            Discard pending file
          </button>
        )}
        {designation.kind === "unknown" && <p>{designation.message}</p>}
        {listing.kind === "loading" && <p>Loading saved deliverables…</p>}
        {listing.kind === "failed" && <p>{listing.message}</p>}
      </div>
      <button
        type="button"
        className="btn"
        disabled={designation.kind === "saving" || listing.kind === "loading"}
        onClick={() => void refresh()}
      >
        Refresh deliverables
      </button>
      {listing.kind === "ready" &&
        (listing.rows.length ? (
          <ul className="deal-document-list">
            {listing.rows.map((row) => (
              <li key={row.id}>
                <h3>{row.filename}</h3>
                <p>
                  {row.bytes.toLocaleString()} bytes ·{" "}
                  {row.visibility === "private" ? "Private" : "Shared · ready for publication"} · Version {row.version}
                </p>
                <a className="btn" href={`/api/v1/deal-deliverables/${dealId}/${row.id}/download`}>
                  Download {row.filename}
                </a>{" "}
                <button
                  type="button"
                  className="btn"
                  disabled={designation.kind !== "idle"}
                  onClick={() => void visibility(row)}
                >
                  {designation.kind === "saving" && designation.id === row.id
                    ? "Saving…"
                    : row.visibility === "private"
                      ? `Mark ${row.filename} shared`
                      : `Make ${row.filename} private`}
                </button>
                <details>
                  <summary>File identity</summary>
                  <p>SHA-256 {row.sha256}</p>
                  <p>{row.id}</p>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p>No deliverables yet. Choose a file to add the first.</p>
        ))}
    </section>
  );
}
