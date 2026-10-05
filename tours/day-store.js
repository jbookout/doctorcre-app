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

export function noteState(note) {
  if (note.storage_error || note.status === "failed") return "Audio not saved";
  if (note.status === "recording") return "Recording";
  return note.audio?.size ? "Saved on phone · Filing unavailable" : "Audio unavailable";
}
