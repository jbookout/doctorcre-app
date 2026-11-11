import { useEffect, useRef, useState } from "react";
import type { TourListModel, TourProperty } from "./tour-list-state";

export function TourList({
  model,
  openProperty,
  embedded = false,
}: {
  model: TourListModel;
  openProperty: (id: string) => void;
  embedded?: boolean;
}) {
  const [state, setState] = useState(model.state);
  const [confirm, setConfirm] = useState<"reload" | "signout" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (confirm) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirm]);
  useEffect(() => {
    setState(model.state);
    const unsubscribe = model.subscribe(setState);
    const leave = (event: BeforeUnloadEvent) => {
      if (model.unsaved) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const expire = () => model.expire();
    window.addEventListener("beforeunload", leave);
    window.addEventListener("doctorcre-session-invalidated", expire);
    window.addEventListener("pagehide", expire);
    return () => {
      unsubscribe();
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("doctorcre-session-invalidated", expire);
      window.removeEventListener("pagehide", expire);
    };
  }, [model]);
  if (state.kind === "expired" || state.kind === "disposed") return null;
  const draft = "draft" in state ? state.draft : undefined;
  const editable = state.kind === "ready" || state.kind === "dirty";
  const selected = new Set(draft?.selected ?? []);
  const message = {
    loading: "Loading shared list…",
    unavailable: "Shared list unavailable. Retry to load it.",
    ready: "Shared list loaded. Your saved choices are proposals for your CARR advisor.",
    dirty: "Unsaved changes.",
    saving: "Saving your selection proposal…",
    conflict:
      "Someone else changed the shared list. Saving is locked. Reload to review their version; this discards your edits.",
    uncertain: "Save not confirmed. Your choices may have reached the server. Retry the same save before editing.",
    "signing-out": "Signing out…",
    "signout-uncertain": "Private content cleared. Server sign out is not confirmed. Retry sign out.",
  }[state.kind];
  const requestReload = () => {
    if (model.unsaved) setConfirm("reload");
    else void model.reload();
  };
  const requestSignout = () => {
    if (model.unsaved) setConfirm("signout");
    else void model.signOut();
  };
  const card = (property: TourProperty, chosen: boolean) => {
    const note = draft && Object.hasOwn(draft.notes, property.id) ? (draft.notes[property.id] ?? "") : "";
    return (
      <article
        className="tour-option"
        key={property.id}
        data-property-id={property.id}
        draggable={!chosen && editable}
        onDragStart={(event) => {
          if (editable) event.dataTransfer.setData("text/plain", property.id);
        }}
      >
        <span aria-hidden="true">
          {chosen ? "✓" : "⠿"} {property.number}
        </span>
        <h3>
          <button type="button" onClick={() => openProperty(property.id)}>
            {property.address}
          </button>
        </h3>
        <p>{property.summary}</p>
        {property.role === "retired" && (
          <p>
            This saved property is no longer published. Its original note is preserved. Remove it before saving a new
            proposal.
          </p>
        )}
        <button
          type="button"
          data-add={!chosen ? property.id : undefined}
          data-remove={chosen ? property.id : undefined}
          disabled={!editable}
          onClick={() => model.edit(property.id, !chosen)}
        >
          {chosen ? "Remove" : "Add"}
          <span className="tour-sr"> {property.address}</span>
        </button>
        {chosen && (
          <label>
            Notes for {property.address}
            <textarea
              value={note}
              maxLength={2000}
              disabled={!editable || property.role === "retired"}
              onChange={(event) => model.note(property.id, event.target.value)}
            />
            <small>{note.length} / 2,000 characters</small>
          </label>
        )}
      </article>
    );
  };
  return (
    <section id="tour" className="portal-tour-list" aria-label="Tour List" data-state={state.kind}>
      <header>
        <div>
          {embedded ? <h2>Your property choices</h2> : <h1>Tour List</h1>}
          <p>Choose properties and share notes with your CARR advisor.</p>
        </div>
        <button type="button" disabled={state.kind === "signing-out"} onClick={requestSignout}>
          Sign Out
        </button>
      </header>
      <p id="tour-save-status" role="status" aria-live="polite">
        {message}
      </p>
      {draft && (
        <>
          <p>
            Shared version {draft.version} · {selected.size} selected
          </p>
          <div className="tour-panels">
            <section id="tour-available" aria-label="Available properties">
              <h2>Available properties</h2>
              {model.properties
                .filter((property) => !selected.has(property.id))
                .map((property) => card(property, false))}
            </section>
            <section
              id="tour-selected"
              aria-label="Selected properties"
              onDragOver={(event) => {
                if (editable) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (editable) model.edit(event.dataTransfer.getData("text/plain"), true);
              }}
            >
              <h2>
                Your selections <span>{selected.size}</span>
              </h2>
              <p>Drag a property here or use Add.</p>
              {selected.size === 0 && <p>No properties selected yet.</p>}
              {model.properties.filter((property) => selected.has(property.id)).map((property) => card(property, true))}
            </section>
          </div>
        </>
      )}
      <div className="tour-actions">
        <button
          id="tour-save"
          type="button"
          disabled={state.kind !== "dirty" && state.kind !== "uncertain"}
          onClick={() => void model.save()}
        >
          {state.kind === "uncertain" ? "Retry same save" : "Save Selections"}
        </button>
        <button
          id="tour-reload"
          type="button"
          disabled={!["ready", "dirty", "conflict", "unavailable"].includes(state.kind)}
          onClick={requestReload}
        >
          {state.kind === "unavailable" ? "Retry loading list" : "Reload Shared List"}
        </button>
      </div>
      <p>
        This shortlist is not a tour appointment. Your CARR advisor will review your proposal and coordinate next steps.
      </p>
      <dialog ref={dialog} role="alertdialog" aria-label="Discard unsaved changes?" onCancel={() => setConfirm(null)}>
        <h2>Discard unsaved changes?</h2>
        <p>
          {confirm === "reload"
            ? "Reloading replaces your edits with the shared list."
            : "Signing out clears your unsaved choices and notes."}
        </p>
        <button type="button" onClick={() => setConfirm(null)}>
          Keep editing
        </button>
        <button
          type="button"
          onClick={() => {
            const action = confirm;
            setConfirm(null);
            if (action === "reload") void model.reload(true);
            else void model.signOut(true);
          }}
        >
          Discard and {confirm === "reload" ? "reload" : "sign out"}
        </button>
      </dialog>
    </section>
  );
}
