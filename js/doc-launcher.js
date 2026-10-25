export function createDocLauncher(root) {
  const strip = root.createElement('section'); strip.id = 'docPresence'; strip.className = 'doc-presence'; strip.setAttribute('aria-label', 'Doc');
  strip.innerHTML = '<button id="docOpen" class="doc-identity" type="button" aria-label="Open Doc" title="Doc · ⌘D / Ctrl+D · ⌘K / Ctrl+K" aria-keyshortcuts="Meta+D Control+D Meta+K Control+K" aria-haspopup="dialog" aria-controls="docDetail"><span class="doc-orb" aria-hidden="true">◍</span></button>';
  return strip;
}

export function placeDocPresence(root, strip) {
  const hosts = [...root.querySelectorAll('dialog[open]:not(#docDetail):not(#docMorningBrief), aside#recordPanel:not([hidden])')];
  const workspace = root.getElementById('accountWorkspaceControls');
  const popup = hosts.at(-1);
  const host = popup?.querySelector('[data-doc-presence-slot]') || popup || (workspace && !workspace.hidden ? workspace : root.body);
  if (strip.parentElement !== host) {
    if (host === workspace) host.querySelector('h3').after(strip);
    else host.prepend(strip);
  }
}

export function mountDocLauncher({ document: root, window: win }) {
  const style = root.createElement('link'); style.rel = 'stylesheet'; style.href = '/css/doc-presence.css'; root.head.append(style);
  const strip = createDocLauncher(root);
  root.body.append(strip);
  let pending = null, presence = null, disposed = false;
  const placement = new win.MutationObserver(() => placeDocPresence(root, strip));
  placement.observe(root.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden'] });
  placeDocPresence(root, strip);
  const unbind = () => {
    placement.disconnect();
    root.removeEventListener('doctorcre:open-doc', open);
    root.removeEventListener('keydown', shortcut, true);
  };
  const open = () => {
    if (strip.closest('#accountWorkspaceControls') && !root.getElementById('accountMenu')?.hidden) {
      const avatar = root.getElementById('selfAvatar'); avatar?.click(); avatar?.focus();
    }
    const opener = root.activeElement;
    const returnToDoc = strip.contains(opener);
    pending ||= import('./doc-presence.js').then(({ mountDocPresence }) => {
      if (disposed) return;
      unbind(); strip.remove(); style.remove();
      presence = mountDocPresence({ document: root, window: win });
      (returnToDoc ? root.getElementById('docOpen') : opener)?.focus();
      presence?.open();
    }).catch(() => {
      pending = null;
      if (!disposed) strip.querySelector('button').setAttribute('aria-label', 'Doc unavailable. Retry opening Doc');
    });
    return pending;
  };
  const shortcut = event => {
    if (event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || !['d', 'k'].includes(event.key.toLowerCase())) return;
    event.preventDefault();
    if (!event.repeat) open();
  };
  strip.querySelector('button').onclick = open;
  root.addEventListener('doctorcre:open-doc', open);
  root.addEventListener('keydown', shortcut, true);
  const dispose = () => { disposed = true; unbind(); presence?.dispose(); };
  win.addEventListener('pagehide', event => { if (!event.persisted) dispose(); });
  return { dispose };
}
