// App-owned drafts only. Canonical notes and business filing belong to CARR.
export function createDayStore(indexedDB, name = "doctorcre-tour-day-drafts-v1") {
  const opened = new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new Error("storage_unavailable")); return; }
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("notes", { keyPath: ["scope", "id"] });
      request.result.createObjectStore("tours", { keyPath: ["scope", "id"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(new Error("storage_unavailable"));
  });
  async function transaction(table, operation, mode = "readwrite") {
    const db = await opened;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(table, mode), store = tx.objectStore(table);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(new Error("storage_unavailable"));
      operation(store, value => { result = value; });
    });
  }
  return {
    putTour(scope, tour) { return transaction("tours", store => store.put({ scope, id: tour.id, tour, updated_at: new Date().toISOString() })); },
    getTour(scope, id) { return transaction("tours", (store, done) => { const r = store.get([scope, id]); r.onsuccess = () => done(r.result); }, "readonly"); },
    put(note) { return transaction("notes", store => store.put(note)); },
    list(scope, tourId) { return transaction("notes", (store, done) => { const r = store.getAll(); r.onsuccess = () => done(r.result.filter(n => n.scope === scope && n.tour_id === tourId)); }, "readonly"); },
    async patch(scope, id, changes) {
      return transaction("notes", (store, done) => {
        const r = store.get([scope, id]);
        r.onsuccess = () => {
          if (!r.result) { done(null); return; }
          const next = { ...r.result, ...changes }; store.put(next); done(next);
        };
      });
    },
    async close() { (await opened).close(); },
  };
}

export function noteState(note, available = false) {
  if (note.status === "recording") return "Recording";
  if (note.status === "filed") return "Filed to tour & client";
  if (note.status === "processing") return "Preparing note";
  if (note.status === "uncertain") return "Checking sync";
  if (note.status === "syncing") return "Syncing";
  return available ? "Saved on phone · Waiting to sync" : "Saved on phone · Filing unavailable";
}

export function matchesNote(note, receipt) {
  return ["id", "tour_id", "client_id", "property_id", "route_version_id", "route_stop_id"].every(key => receipt?.[key] === note[key]);
}

// Unknown write outcomes are read before any resend. The same immutable note ID
// is the producer's idempotency key; processing does not imply business filing.
export function createNoteSync({ store, api, scope, tourId, onChange = () => {} }) {
  let running = null;
  async function run() {
    if (!api.capabilities?.voiceNotes || api.scope !== scope) return;
    for (const note of await store.list(scope, tourId)) {
      if (api.scope !== scope) break;
      if (["recording", "filed", "empty"].includes(note.status) || !note.audio?.size) continue;
      try {
        let receipt;
        if (["uncertain", "syncing", "processing"].includes(note.status)) {
          receipt = await api.lookupNote(note.id);
          // Only an explicit authoritative absence allows the same-key resend.
          if (receipt?.status !== "absent" && !matchesNote(note, receipt)) throw new Error("receipt_mismatch");
        }
        if (!receipt || receipt.status === "absent") {
          await store.patch(scope, note.id, { status: "syncing" }); onChange();
          if (api.scope !== scope) break;
          receipt = await api.submitNote(note);
        }
        if (api.scope !== scope || !matchesNote(note, receipt)) throw new Error("receipt_mismatch");
        const filed = receipt.status === "filed" && typeof receipt.summary === "string" && receipt.summary.trim()
          && typeof receipt.transcript === "string" && receipt.transcript.trim()
          && typeof receipt.tour_feedback_ref === "string" && receipt.tour_feedback_ref
          && typeof receipt.client_activity_ref === "string" && receipt.client_activity_ref;
        if (!filed && receipt.status !== "processing") throw new Error("receipt_incomplete");
        await store.patch(scope, note.id, { status: filed ? "filed" : "processing", receipt, summary: receipt.summary || "", transcript: receipt.transcript || "" });
      } catch { await store.patch(scope, note.id, { status: "uncertain" }); }
      onChange();
    }
  }
  return { sync() { if (!running) running = run().finally(() => { running = null; }); return running; } };
}
