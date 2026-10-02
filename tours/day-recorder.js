export function createDayRecorder({ window, store, onChange = () => {}, onError = () => {} }) {
  let active = null, disposed = false, generation = 0;
  const release = stream => stream?.getTracks().forEach(track => track.stop());
  const lockName = note => `doctorcre-tour-capture:${JSON.stringify([note.scope, note.id])}`;
  const notify = (state, callback, ...args) => { if (!disposed && state.generation === generation) callback(...args); };
  // A browser-owned lock survives asynchronous writes and disappears on tab
  // death. Recovery must acquire the same lock before changing a recording row.
  async function claim(note) {
    if (!window.navigator.locks) throw new Error("capture_ownership_unavailable");
    return new Promise((resolve, reject) => {
      window.navigator.locks.request(lockName(note), { ifAvailable: true }, async lock => {
        if (!lock) { reject(new Error("capture_owned")); return; }
        await new Promise(unlock => { resolve(unlock); });
      }).catch(reject);
    });
  }
  async function recover(rows) {
    if (!window.navigator.locks) return rows;
    for (const note of rows) {
      if (note.status !== "recording" || active?.note.id === note.id) continue;
      await window.navigator.locks.request(lockName(note), { ifAvailable: true }, async lock => {
        if (!lock) return;
        const current = (await store.list(note.scope, note.tour_id)).find(row => row.id === note.id);
        if (!current) return;
        if (current.status === "recording") {
          const status = current.storage_error ? "failed" : current.audio?.size ? "local" : "empty";
          Object.assign(current, await store.patch(note.scope, note.id, { status, interrupted: true }));
        }
        Object.assign(note, current);
      });
    }
    return rows;
  }
  async function start(binding) {
    if (active || disposed) return;
    if (!window.navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("recording_unavailable");
    // Freeze the property binding BEFORE awaiting microphone consent.
    const note = { ...binding, id: window.crypto.randomUUID(), captured_at: new Date().toISOString(), status: "recording", phase: "requesting", summary: "", transcript: "" };
    const state = { note, generation, unlock: null, stream: null, recorder: null, chunks: [], pending: Promise.resolve(), stopping: false, timer: null, bytes: 0, savedBytes: 0 };
    active = state; onChange(note);
    try {
      state.unlock = await claim(note);
      if (active !== state || disposed || state.stopping) { state.unlock(); return; }
      await store.put(note);
      const stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
      if (active !== state || disposed || state.stopping) { release(stream); await store.patch(note.scope, note.id, { status: "empty" }); state.unlock(); return; }
      state.stream = stream;
      const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus"].find(type => window.MediaRecorder.isTypeSupported(type));
      state.recorder = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      state.recorder.ondataavailable = event => {
        if (!event.data?.size) return;
        state.chunks.push(event.data); state.bytes += event.data.size;
        const audio = new window.Blob(state.chunks, { type: state.recorder.mimeType || event.data.type });
        state.note.audio = audio;
        state.pending = state.pending.then(async () => {
          if (!await store.patch(note.scope, note.id, { audio })) throw new Error("note_missing");
          state.savedBytes = audio.size;
        }).catch(() => {
          state.note.storage_error = true; notify(state, onError, "Audio not saved · Phone storage unavailable", state.note); stopState(state);
        });
        if (state.bytes >= 25 * 1024 * 1024) stopState(state);
      };
      state.recorder.onstop = async () => {
        window.clearTimeout(state.timer); release(stream);
        await state.pending;
        state.note.status = state.note.storage_error ? "failed" : state.savedBytes && state.savedBytes === state.note.audio?.size ? "local" : "empty";
        try { await store.patch(note.scope, note.id, { status: state.note.status, storage_error: Boolean(state.note.storage_error) }); }
        catch { state.note.status = "failed"; state.note.storage_error = true; notify(state, onError, "Audio not saved · Download audio", state.note); }
        if (active === state) active = null;
        state.unlock(); notify(state, onChange, state.note);
      };
      state.recorder.onerror = () => { notify(state, onError, "Recording interrupted", state.note); stopState(state); };
      state.recorder.start(1000);
      state.note.phase = "recording";
      state.timer = window.setTimeout(() => stopState(state), 10 * 60_000);
      notify(state, onChange, state.note);
    } catch (error) {
      release(state.stream); if (active === state) active = null;
      await store.patch(note.scope, note.id, { status: "empty" }).catch(() => {});
      state.unlock?.(); notify(state, onChange, null); throw error;
    }
  }
  function stopState(state) {
    if (!state || state.stopping) return;
    state.stopping = true;
    if (state.recorder?.state !== "inactive" && state.recorder) state.recorder.stop();
    else { if (active === state) active = null; release(state.stream); notify(state, onChange, null); }
  }
  const stop = () => stopState(active);
  function invalidate() { ++generation; stop(); active = null; }
  return { start, stop, recover, invalidate, get active() { return active?.note || null; }, dispose() { disposed = true; invalidate(); } };
}
