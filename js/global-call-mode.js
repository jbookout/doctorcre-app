import { createCallMode } from "./call-mode.js";
import { createPostCallClient } from "./post-call-client.js";
import { createClient } from "./client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
const mounted = new WeakMap();
export async function mountGlobalCallMode(root = document) {
  if (mounted.has(root)) return mounted.get(root);
  const boot = resolveDealroomBoot(globalThis.location);
  const client = await createClient(boot.mode, boot.options);
  const host = root.createElement("div");
  host.innerHTML = '<dialog id="callModeDialog" class="dialog call-mode-dialog" aria-labelledby="callModeTitle">\n    <article>\n      <header>\n        <div><p class="eyebrow">Calls</p><h2 id="callModeTitle">Call Mode</h2></div>\n        <button type="button" class="icon-button" id="callModeClose" aria-label="Close Call Mode">×</button>\n      </header>\n      <div class="call-mode-stage" id="callModeStage">\n        <div class="recording-orb" aria-hidden="true">●</div>\n        <p class="call-mode-state" id="callModeState">Ready to record</p>\n        <time class="call-mode-timer" id="callModeTimer" aria-live="polite">Ready</time>\n        \n        <p class="call-mode-speakers" id="callModeSpeakers" hidden></p>\n      </div>\n      <div class="call-mode-actions">\n        <label class="call-mode-consent" id="callModeConsentRow">\n          <input type="checkbox" id="callModeConsent">\n          <span>I have told everyone on this call that it will be recorded.</span>\n        </label>\n        <div class="call-mode-starts" id="callModeStarts">\n          <button type="button" class="primary" data-call-mode-start="weekly_deal_call">Start weekly deal call</button>\n          <button type="button" class="secondary" data-call-mode-start="other_call">Start another call</button>\n        </div>\n        <button type="button" class="danger" id="callModeStop" hidden>Stop and process</button>\n        \n      </div>\n      <p class="call-mode-permission" id="callModePermission" hidden></p>\n      <section class="post-call" id="postCallPanel" aria-labelledby="postCallTitle" hidden>\n        <header class="post-call-heading">\n          <div><p class="eyebrow">Weekly call follow-through</p><h3 id="postCallTitle">Post-call report</h3></div>\n          <button type="button" class="text-button post-call-refresh" id="postCallRefresh" aria-label="Refresh" title="Refresh"><span aria-hidden="true">↻</span></button>\n        </header>\n        <div class="post-call-status" id="postCallStatus" role="status" aria-live="polite"></div>\n        <div class="post-call-report" id="postCallReport"></div>\n      </section>\n      <footer class="call-mode-footer"><a href="http://127.0.0.1:4682/" target="_blank" rel="noopener" id="callModeStandalone">Open standalone local controller</a></footer>\n    </article>\n  </dialog>';
  root.body.append(host);
  let deals = [];
  const call = createCallMode({ root, client: () => client, postCallClient: createPostCallClient(),
    agendaDeals: () => deals, scope: () => ({ workspace_kind: "all" }),
    dealName: (id) => deals.find(deal => deal.id === id)?.name,
    toast: (message) => { const node = root.getElementById("callModePermission"); node.hidden = false; node.textContent = message; },
    onConfirmed: () => {} });
  host.addEventListener("click", (event) => call.handleClick(event.target));
  root.getElementById("callModeStop").onclick = () => call.stop();
  root.getElementById("postCallRefresh").onclick = () => call.refreshPostCall();
  const mountedCall = { ...call, async open() { try { const board = await client.getBoard({ workspace: "all" }); deals = board.deals || []; } catch { deals = []; } await call.open(); } };
  mounted.set(root, mountedCall);
  return mountedCall;
}
