// A read-only refresh after a page returns to view. A browser can
// deliver both visibilitychange and pageshow for one return, so one transition
// makes one read. A second return during an in-flight read is queued once.
export function mountReadOnResume({ document, window, refresh }) {
  let hidden = document.visibilityState === "hidden";
  let resumed = false;
  let reading = false;
  let queued = false;

  const read = () => {
    if (reading) { queued = true; return; }
    reading = true;
    Promise.resolve().then(refresh).catch(() => {
      // The page's read path renders its own failure. A rejected callback must
      // not prevent the next return from retrying it.
    }).finally(() => {
      reading = false;
      if (queued && document.visibilityState === "visible") {
        queued = false;
        read();
      } else {
        queued = false;
      }
    });
  };

  const visibility = () => {
    if (document.visibilityState === "hidden") {
      hidden = true;
      resumed = false;
    } else if (hidden && !resumed) {
      hidden = false;
      resumed = true;
      read();
    }
  };

  // Some back-forward cache restores do not deliver visibilitychange. The
  // pagehide/pageshow pair is the browser's explicit boundary in that case.
  const pagehide = () => {
    hidden = true;
    resumed = false;
  };

  const pageshow = (event) => {
    if (!event.persisted || document.visibilityState !== "visible" || resumed) return;
    hidden = false;
    resumed = true;
    read();
  };
  // eslint-disable-next-line no-restricted-syntax -- 20 automatic dispatches; document transport also caps at 600 HTTP attempts. Shares the poll helper attempt counter and active failure/progressive backoff, ceiling 15 minutes Hidden or 30-minute idle; no lifecycle event replenishes presence or attempts
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("pageshow", pageshow);
  return { dispose() { document.removeEventListener?.("visibilitychange", visibility); window.removeEventListener?.("pagehide", pagehide); window.removeEventListener?.("pageshow", pageshow); } };
}
