const key = 'doctorcre-tour-day-session-v1';
export const SESSION_EPOCH_KEY = 'doctorcre-session-epoch-v1';
export function sessionEpoch(window) {
  try { return window.localStorage.getItem(SESSION_EPOCH_KEY) || 'initial'; } catch { return null; }
}
export async function clearPrivateStorage(window) {
  for (const name of ['localStorage','sessionStorage']) {
    try {
      const storage = window[name];
      // eslint-disable-next-line no-restricted-syntax -- Revocation visits each storage key once in descending order; deletion cannot extend the finite scan.
      for (let i = storage.length - 1; i >= 0; i--) {
        const k = storage.key(i);
        if (/^doctorcre[.:-]/.test(k) && k !== SESSION_EPOCH_KEY && k !== 'doctorcre.visual-preferences') storage.removeItem(k);
      }
    } catch { /* Revocation remains fail-closed when browser storage is denied. */ }
  }
  const tasks = [];
  if (window.caches) tasks.push(window.caches.keys().then(names => Promise.all(names.map(name => window.caches.delete(name)))));
  if (window.indexedDB) tasks.push(new Promise(resolve => {
    const request = window.indexedDB.open('doctorcre-tour-day-drafts-v1',1);
    request.onupgradeneeded = () => { request.result.createObjectStore('notes',{keyPath:['scope','id']}); request.result.createObjectStore('tours',{keyPath:['scope','id']}); };
    request.onerror = request.onblocked = () => resolve();
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['notes','tours'],'readwrite');
      tx.objectStore('notes').clear(); tx.objectStore('tours').clear();
      tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
    };
  }));
  window.navigator?.serviceWorker?.controller?.postMessage({type:'doctorcre-session-revoked'});
  await Promise.allSettled(tasks);
}
export function offlineTourSession(window) {
  const clear = () => window.sessionStorage.removeItem(key);
  return {
    clear,
    save(binding) {
      const epoch = sessionEpoch(window);
      if (epoch === null) { clear(); return; }
      window.sessionStorage.setItem(key,JSON.stringify({...binding,epoch}));
    },
    read(tourId) {
      try {
        const saved = JSON.parse(window.sessionStorage.getItem(key));
        return sessionEpoch(window) !== null && saved?.epoch === sessionEpoch(window) && saved?.tourId === tourId && typeof saved.scope === 'string' && saved.scope && typeof saved.userRef === 'string' ? saved : null;
      } catch { return null; }
    },
    async revoke() {
      try { window.localStorage.setItem(SESSION_EPOCH_KEY, window.crypto.randomUUID()); } catch { /* Offline restore requires storage. */ }
      try { clear(); } finally { window.dispatchEvent(new window.Event('doctorcre-offline-session-revoked')); }
      await clearPrivateStorage(window);
    },
  };
}
