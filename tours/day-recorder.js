export function createDayRecorder({ window, store, onChange = () => {}, onError = () => {} }) {
  let active = null, disposed = false;
  const release = stream => stream?.getTracks().forEach(track => track.stop());
  async function start(binding) {
    if (active || disposed) return;
    if (!window.navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("recording_unavailable");
    // Freeze the property binding BEFORE awaiting microphone consent.
    const note = { ...binding, id: window.crypto.randomUUID(), captured_at: new Date().toISOString(), status: "recording", phase: "requesting", summary: "", transcript: "" };
    const state = { note, stream: null, recorder: null, chunks: [], pending: Promise.resolve(), stopping: false, timer: null, bytes: 0 };
    active = state; onChange(note);
    try {
      await store.put(note);
      const stream = await window.navigator.mediaDevices.getUserMedia({ audio: true });
      if (active !== state || disposed || state.stopping) { release(stream); await store.patch(note.scope, note.id, { status: "empty" }); return; }
      state.stream = stream;
      const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus"].find(type => window.MediaRecorder.isTypeSupported(type));
      state.recorder = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      state.recorder.ondataavailable = event => {
        if (!event.data?.size) return;
        state.chunks.push(event.data); state.bytes += event.data.size;
        const audio = new window.Blob(state.chunks, { type: state.recorder.mimeType || event.data.type });
        state.note.audio = audio;
        state.pending = state.pending.then(() => store.patch(note.scope, note.id, { audio })).catch(() => {
          state.note.storage_error = true; onError("Audio not saved · Phone storage unavailable", state.note); stop();
        });
        if (state.bytes >= 25 * 1024 * 1024) stop();
      };
      state.recorder.onstop = async () => {
        window.clearTimeout(state.timer); release(stream);
        await state.pending;
        state.note.status = state.note.audio?.size ? "local" : "empty";
        try { await store.patch(note.scope, note.id, { status: state.note.status }); }
        catch { state.note.storage_error = true; onError("Audio not saved · Download audio", state.note); }
        if (active === state) active = null;
        onChange(state.note);
      };
      state.recorder.onerror = () => { onError("Recording interrupted", state.note); stop(); };
      state.recorder.start(1000);
      state.note.phase = "recording";
      state.timer = window.setTimeout(stop, 10 * 60_000);
      onChange(state.note);
    } catch (error) {
      release(state.stream); if (active === state) active = null;
      await store.patch(note.scope, note.id, { status: "empty" }).catch(() => {});
      onChange(null); throw error;
    }
  }
  function stop() {
    const state = active;
    if (!state || state.stopping) return;
    state.stopping = true;
    if (state.recorder?.state !== "inactive" && state.recorder) state.recorder.stop();
    else { active = null; release(state.stream); void store.patch(state.note.scope, state.note.id, { status: "empty" }).catch(() => {}); onChange(null); }
  }
  return { start, stop, get active() { return active?.note || null; }, dispose() { disposed = true; stop(); } };
}
