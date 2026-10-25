import { requestCompanion } from './post-call-client.js';

export const isCallModeState = value => ['idle', 'recording', 'transcribing', 'ready_to_extract', 'filed', 'state_unknown'].includes(value?.state);

export function renderCallModeCue(root, snapshot, elapsed = '') {
  const button = root.querySelector('#callModeButton');
  if (!button) return;
  const recording = snapshot?.state === 'recording';
  button.classList.toggle('recording', recording);
  button.innerHTML = recording ? `<span aria-hidden="true">●</span> ${elapsed}` : '<span aria-hidden="true">☎</span>';
  button.setAttribute('aria-label', recording ? `Call Mode recording${elapsed ? ' ' + elapsed : ''}` : 'Call mode');
}

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
      renderCallModeCue(root, value);
      button.hidden = false; notice.hidden = true; retry.hidden = true;
      if (hadFocus) button.focus();
    } catch {
      renderCallModeCue(root, null);
      button.hidden = true; notice.hidden = false; retry.hidden = false;
      notice.textContent = 'Call recording runs on the Mac with Quill';
    } finally { retry.disabled = false; pending = null; }
  })();
  retry.onclick = check;
  check();
}
