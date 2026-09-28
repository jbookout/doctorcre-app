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

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hidden = true;
      resumed = false;
    } else if (hidden && !resumed) {
      hidden = false;
      resumed = true;
      read();
    }
  });

  // Some back-forward cache restores do not deliver visibilitychange. The
  // pagehide/pageshow pair is the browser's explicit boundary in that case.
  window.addEventListener("pagehide", () => {
    hidden = true;
    resumed = false;
  });

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || document.visibilityState !== "visible" || resumed) return;
    hidden = false;
    resumed = true;
    read();
  });
}
