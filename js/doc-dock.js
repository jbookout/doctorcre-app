// One floating Doc entry on every surface. Until an assistant and capture are
// connected here, offer the working conversation list without simulated turns.
export function mountDocDock(reading) {
  const fab = document.getElementById('docFab');
  const chat = document.getElementById('docChat');
  if (!fab || !chat) return null;
  const transcript = document.getElementById('docTranscript');
  const form = document.getElementById('docForm');
  const mic = document.getElementById('docMic');
  const label = document.getElementById('docReading');
  let opener = null;

  const setReading = (text) => { if (label) label.textContent = `Page: ${text}`; };
  setReading(reading);
  const notice = document.createElement('p');
  notice.textContent = 'Doc cannot answer here yet.';
  const chats = document.createElement('a');
  chats.className = 'btn btn-primary';
  chats.href = '/conversations.html';
  chats.textContent = 'Open Doc Chats';
  transcript?.replaceChildren(notice, chats);
  if (form) {
    form.hidden = true;
    form.addEventListener('submit', (event) => event.preventDefault());
  }
  if (mic) {
    mic.disabled = true;
    mic.setAttribute('aria-pressed', 'false');
    mic.setAttribute('aria-describedby', 'docDictationReason');
    transcript?.append(mic);
    const reason = document.createElement('p');
    reason.id = 'docDictationReason';
    reason.className = 'small';
    reason.textContent = 'Dictation is not available here yet.';
    transcript?.append(reason);
  }

  const open = (context) => {
    opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : fab;
    if (context) setReading(context);
    chat.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    chats.focus();
  };
  const close = () => {
    if (chat.hidden) return;
    chat.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
    (opener || fab).focus();
  };
  fab.addEventListener('click', () => (chat.hidden ? open() : close()));
  document.getElementById('docChatClose')?.addEventListener('click', close);
  chat.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  fab.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  return { open, close, setReading };
}
