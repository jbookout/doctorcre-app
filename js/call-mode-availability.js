import { requestCompanion } from './post-call-client.js';

export const isCallModeState = value => ['idle', 'recording', 'transcribing', 'ready_to_extract', 'filed', 'state_unknown'].includes(value?.state);

export function mountCallModeAvailability(root) {
  const button = root.getElementById('callModeButton');
  const notice = root.getElementById('callModeAvailability');
  const retry = root.getElementById('callModeRetry');
  let pending = null;
  const check = () => pending ||= (async () => {
    const hadFocus = root.activeElement === retry;
    retry.disabled = true;
    notice.textContent = 'Checking Quill on this device…';
    try {
      const value = await requestCompanion('http://127.0.0.1:4682/api/state', {}, { timeoutMs: 1200 });
      if (!isCallModeState(value)) throw new Error('Invalid companion state');
      button.hidden = false; notice.hidden = true; retry.hidden = true;
      if (hadFocus) button.focus();
    } catch {
      button.hidden = true; notice.hidden = false; retry.hidden = false;
      notice.textContent = 'Call recording runs on the Mac with Quill';
    } finally { retry.disabled = false; pending = null; }
  })();
  retry.onclick = check;
  check();
}
