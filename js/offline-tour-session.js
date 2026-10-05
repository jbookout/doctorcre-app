const key = "doctorcre-tour-day-session-v1";

export function offlineTourSession(window) {
  const clear = () => window.sessionStorage.removeItem(key);
  return {
    clear,
    save(binding) { window.sessionStorage.setItem(key, JSON.stringify(binding)); },
    read(tourId) {
      try {
        const saved = JSON.parse(window.sessionStorage.getItem(key));
        return saved?.tourId === tourId && typeof saved.scope === "string" && saved.scope && typeof saved.userRef === "string" ? saved : null;
      } catch { return null; }
    },
    revoke() { try { clear(); } finally { window.dispatchEvent(new window.Event("doctorcre-offline-session-revoked")); } },
  };
}
