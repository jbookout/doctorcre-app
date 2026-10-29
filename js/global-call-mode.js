import { requestCompanion, createPostCallClient, CALL_MODE_URL, CALL_MODE_STATES } from "./post-call-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
const mounted = new WeakMap();
const DIALOG = '<dialog id="callModeDialog" class="dialog call-mode-dialog" aria-labelledby="callModeTitle">\n    <article>\n      <header>\n        <div><p class="eyebrow">Calls</p><h2 id="callModeTitle">Call Mode</h2></div>\n        <button type="button" class="icon-button" id="callModeClose" aria-label="Close Call Mode">×</button>\n      </header>\n      <div class="call-mode-stage" id="callModeStage">\n        <div class="recording-orb" aria-hidden="true">●</div>\n        <p class="call-mode-state" id="callModeState">Ready to record</p>\n        <time class="call-mode-timer" id="callModeTimer" aria-live="polite">Ready</time>\n        \n        <p class="call-mode-speakers" id="callModeSpeakers" hidden></p>\n      </div>\n      <div class="call-mode-actions">\n        <label class="call-mode-consent" id="callModeConsentRow">\n          <input type="checkbox" id="callModeConsent">\n          <span>I have told everyone on this call that it will be recorded.</span>\n        </label>\n        <div class="call-mode-starts" id="callModeStarts">\n          <button type="button" class="primary" data-call-mode-start="weekly_deal_call">Start weekly deal call</button>\n          <button type="button" class="secondary" data-call-mode-start="other_call">Start another call</button>\n        </div>\n        <button type="button" class="danger" id="callModeStop" hidden>Stop and process</button>\n        \n      </div>\n      <p class="call-mode-permission" id="callModePermission" hidden></p>\n      <section class="post-call" id="postCallPanel" aria-labelledby="postCallTitle" hidden>\n        <header class="post-call-heading">\n          <div><p class="eyebrow">Weekly call follow-through</p><h3 id="postCallTitle">Post-call report</h3></div>\n          <button type="button" class="text-button post-call-refresh" id="postCallRefresh" aria-label="Refresh" title="Refresh"><span aria-hidden="true">↻</span></button>\n        </header>\n        <div class="post-call-status" id="postCallStatus" role="status" aria-live="polite"></div>\n        <div class="call-outcomes" id="postCallOutcomes" hidden></div><div class="post-call-report" id="postCallReport"></div>\n      </section>\n      <footer class="call-mode-footer"><a href="http://127.0.0.1:4682/" target="_blank" rel="noopener" id="callModeStandalone">Open standalone local controller</a></footer>\n    </article>\n  </dialog>';

/**
 * Page load only asks whether the recorder is reachable. The dialog, its
 * controller and their code are built when a partner first opens Call Mode.
 */
export async function mountGlobalCallMode(root = document) {
  if (mounted.has(root)) return mounted.get(root);
  const boot = resolveDealroomBoot(globalThis.location);
  const $ = (id) => root.getElementById(id);
  let built, call, client, probing;
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const show = (state) => {
    const button = $("callModeButton"), availability = $("callModeAvailability"), retry = $("callModeRetry");
    if (!button || !availability || !retry) return false;
    const eligible = state === "available";
    button.hidden = !eligible;
    availability.hidden = eligible;
    availability.textContent = state === "checking" ? "Checking the call recorder…" : "Call recording runs on the Mac";
    retry.hidden = eligible || state === "checking";
    retry.disabled = state === "checking";
    return true;
  };
  const probe = () => signal.aborted ? Promise.resolve(false) : probing ||= (async () => {
    show("checking");
    try {
      const payload = await requestCompanion(`${CALL_MODE_URL}/api/state`, { method: "GET", targetAddressSpace: "loopback" }, { timeoutMs: 1200 });
      if (signal.aborted) return false;
      if (!CALL_MODE_STATES.includes(payload.state)) throw new Error("Unrecognised recorder state");
      if (!show("available")) return false;
      // A call in progress needs the toolbar timer, so only then is the controller built early.
      if (payload.state === "recording") { await build(); return signal.aborted || !call ? false : await call.checkEligibility(); }
      return true;
    } catch { if (!signal.aborted) show("unavailable"); return false; }
    finally { probing = null; }
  })();
  const build = () => built ||= (async () => {
    const [{ createCallMode }, { createClient }] = await Promise.all([import("./call-mode.js"), import("./client.js")]);
    if (signal.aborted || !$("callModeButton")) return null;
    const host = root.createElement("div");
    host.innerHTML = DIALOG;
    root.body.append(host);
    let deals = [], contextError = null;
    call = createCallMode({ root, client: () => client, postCallClient: createPostCallClient(),
      agendaDeals: () => { if (contextError) throw new Error(contextError); return deals; }, scope: () => ({ workspace_kind: "all" }),
      dealName: (id) => deals.find(deal => deal.id === id)?.name,
      toast: (message) => { const node = $("callModePermission"); node.hidden = false; node.textContent = message; },
      onConfirmed: () => {} });
    host.addEventListener("click", (event) => call.handleClick(event.target));
    $("callModeStop").onclick = () => call.stop();
    $("postCallRefresh").onclick = () => call.refreshPostCall();
    return { async load(options) {
      client ||= await createClient(boot.mode, boot.options);
      if (options.session) return null;
      try { const board = await client.getBoard({ workspace: "all" }); if (!Array.isArray(board?.deals)) throw new Error("Invalid board"); deals = board.deals; contextError = null; }
      catch { deals = []; contextError = "Weekly call context unavailable. Reopen Call Mode to retry loading deals."; }
      return contextError;
    } };
  })();
  let opening = false;
  const mountedCall = {
    checkEligibility: () => signal.aborted ? Promise.resolve(false) : call ? call.checkEligibility() : probe(),
    async handleClick(target) {
      if (signal.aborted) return false;
      if (call) return call.handleClick(target);
      const retry = target?.closest?.("#callModeRetry");
      if (!retry) return false;
      const hadFocus = root.activeElement === retry;
      if (await probe() && hadFocus && (root.activeElement === retry || root.activeElement === root.body)) $("callModeButton")?.focus();
      return true;
    },
    dispose() {
      lifetime.abort();
      root.defaultView?.removeEventListener("doctorcre-session-invalidated", mountedCall.dispose);
      call?.dispose?.();
    },
    async open(options = {}) {
      if (signal.aborted || opening || options.signal?.aborted) return false;
      opening = true;
      try {
        const context = await build();
        if (signal.aborted || !context) return false;
        const eligible = await call.checkEligibility();
        if (signal.aborted || !eligible || options.signal?.aborted) return false;
        const contextError = await context.load(options);
        if (signal.aborted || options.signal?.aborted) return false;
        const opened = await call.open({ ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal });
        if (signal.aborted) return false;
        if (contextError) { const notice = $("callModePermission"); notice.hidden = false; notice.textContent = contextError; }
        return opened;
      } finally { opening = false; }
    } };
  mounted.set(root, mountedCall);
  root.defaultView?.addEventListener("doctorcre-session-invalidated", mountedCall.dispose, { once: true });
  await probe();
  return mountedCall;
}
