// A browser lifetime belongs to one verified server session. Re-bootstrap in a
// new document after revocation; never reuse old controllers for a new actor.
import { resolveDealroomBoot } from './boot-mode.js';
import { clearPrivateStorage, offlineTourSession, sessionEpoch, SESSION_EPOCH_KEY } from './offline-tour-session.js';

export function createSessionBoundary({ fetchImpl, invalidate, epoch = () => '', acceptSession = async () => true, anonymousDiagnostics = false }) {
  let binding = null, generation = 0, revoked = false, checking = null;
  const active = new Set();
  const failure = () => Object.assign(new Error('Sign in to continue'), { status: 401, code: 'authentication_required' });
  function revoke(reason = 'denied') {
    if (revoked) return;
    revoked = true; generation++;
    for (const controller of active) controller.abort();
    active.clear(); binding = null;
    invalidate(reason);
  }
  function current(ticket, startedEpoch) {
    if (startedEpoch !== epoch()) revoke('session-changed');
    if (revoked || ticket !== generation) throw failure();
  }
  async function verify() {
    if (revoked) throw failure();
    if (checking) return checking;
    const ticket = generation, startedEpoch = epoch();
    checking = (async () => {
      const response = await fetchImpl('/api/system-work/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if ([401,403].includes(response.status)) { if (!(anonymousDiagnostics && !binding)) revoke(); throw failure(); }
      if (!response.ok) throw new Error('Session verification unavailable');
      const session = await response.json();
      current(ticket, startedEpoch);
      if (typeof session?.actor?.slug !== 'string' || !session.actor.slug || typeof session.csrf_token !== 'string' || !session.csrf_token) throw new Error('Session verification unavailable');
      const next = JSON.stringify([session.actor.slug, session.csrf_token]);
      if (binding && next !== binding) { revoke('session-changed'); throw failure(); }
      if (!await acceptSession(session)) { revoke('session-changed'); throw failure(); }
      current(ticket, startedEpoch);
      binding = next;
      return session;
    })().finally(() => { checking = null; });
    return checking;
  }
  return {
    revoke, verify,
    get revoked() { return revoked; },
    async fetch(path, init = {}) {
      const ticket = generation, startedEpoch = epoch();
      await verify(); current(ticket, startedEpoch);
      const controller = new AbortController(); active.add(controller);
      const cancel = () => controller.abort();
      init.signal?.addEventListener('abort', cancel, { once: true });
      if (init.signal?.aborted) cancel();
      try {
        const response = await fetchImpl(path, { ...init, cache: 'no-store', redirect: 'error', signal: controller.signal });
        // Even an older read's denial revokes the entire view.
        if ([401,403].includes(response.status)) { revoke(); throw failure(); }
        const bytes = await response.arrayBuffer();
        let refused = false;
        try {
          const envelope = JSON.parse(new TextDecoder().decode(bytes));
          const payload = envelope?.result?.isError ? JSON.parse(envelope.result.content?.find(item => item.type === 'text')?.text || '{}') : envelope;
          refused = ['unauthorized','not_authenticated','forbidden','permission_denied'].includes(payload?.error);
        } catch { /* Payload validation belongs to the existing domain adapter. */ }
        if (refused) { revoke(); throw failure(); }
        current(ticket, startedEpoch);
        // Detect a cookie change while the request was in flight before any
        // private body reaches a controller (or a write receipt reaches a form).
        await verify(); current(ticket, startedEpoch);
        return new Response([204,205,304].includes(response.status) ? null : bytes, {status:response.status,statusText:response.statusText,headers:response.headers});
      } finally { active.delete(controller); init.signal?.removeEventListener('abort', cancel); }
    },
  };
}

let browserBoundary;
export function privateSession() {
  if (browserBoundary) return browserBoundary;
  if (typeof window === 'undefined' || globalThis !== window || resolveDealroomBoot(window.location).mode !== 'live') return null;
  const win = window;
  const initialEpoch = sessionEpoch(win);
  let anonymousDiagnostics = false;
  try { anonymousDiagnostics = win.location.pathname === '/status' && !win.localStorage.getItem('doctorcre-session-binding-v1'); } catch {}
  browserBoundary = createSessionBoundary({ anonymousDiagnostics, fetchImpl: (...args) => win.fetch(...args), epoch: () => sessionEpoch(win),
    async acceptSession(session) {
      const bytes = await win.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([session.actor.slug,session.csrf_token])));
      const digest = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2,'0')).join('');
      try {
        const previous = win.localStorage.getItem('doctorcre-session-binding-v1');
        if (previous && previous !== digest) return false;
        // Unbound data from older app versions must never be adopted by the
        // first principal to bootstrap this browser.
        if (!previous) await clearPrivateStorage(win);
        win.localStorage.setItem('doctorcre-session-binding-v1',digest);
      } catch { /* Storage-denied browsers cannot restore private offline state. */ }
      return true;
    },
    invalidate(reason) {
      // Clear before async cleanup/navigation so private text and controls
      // disappear immediately, including detached dialogs and account labels.
      win.dispatchEvent(new win.Event('doctorcre-session-invalidated'));
      const cleanup = offlineTourSession(win).revoke();
      const view = win.document.createElement('main');
      const title = win.document.createElement('h1'); title.textContent = reason === 'signed-out' ? 'Signed out' : 'Session ended';
      const link = win.document.createElement('a'); link.href = '/auth/login'; link.textContent = 'Sign in again';
      view.append(title,link); win.document.body.replaceChildren(view);
      // The new document releases controller closures, pending commands,
      // editor drafts, Doc context, media objects, and actor labels together.
      void cleanup.finally(() => win.location.replace('/public-shell/session-ended.html'));
    },
  });
  win.addEventListener('storage', event => { if (event.key === SESSION_EPOCH_KEY && sessionEpoch(win) !== initialEpoch) browserBoundary.revoke('session-changed'); });
  win.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    if (sessionEpoch(win) !== initialEpoch) { browserBoundary.revoke('session-changed'); return; }
    // A history restore must verify its binding before exposing cached DOM.
    win.document.documentElement.style.visibility = 'hidden';
    void browserBoundary.verify().catch(() => {}).finally(() => {
      win.document.documentElement.style.visibility = '';
    });
  });
  return browserBoundary;
}

export async function sessionFetch(path, init) {
  // Release identity is public diagnostic metadata, including on signed-out
  // /status. It carries no actor or record data and needs no private lifetime.
  if (typeof window !== 'undefined' && window.location?.href && new URL(path,window.location.href).pathname === '/app-release') return globalThis.fetch(path,init);
  const boundary = privateSession();
  if (!boundary) return globalThis.fetch(path,init);
  try { return await boundary.fetch(path,init); }
  catch (error) {
    // Retired page controllers cannot repaint or issue a retry while the
    // replacement document is loading. Caller deadlines still cancel reads.
    if (boundary.revoked) return new Promise(() => {});
    throw error;
  }
}
