// Decide whether a task detail can remain on screen after a board reread.
// The close outcome is page memory only until the person explicitly confirms.
const stillOpen = (snapshot, rows) => Array.isArray(rows) && rows.some((row) =>
  `${row.kind}:${row.number}` === snapshot?.key);

export function taskDialogTransition({ status, open, held, rows, viewer }) {
  if (status !== "ready") {
    return open
      ? { action: "conceal", snapshot: null, held: status === "unauthorized" ? null : open }
      : { action: "none", snapshot: null, held: status === "unauthorized" ? null : held || null };
  }
  if (open) return stillOpen(open, rows) && open.viewer === viewer
    ? { action: "refresh", snapshot: open, held: null }
    : { action: "discard", snapshot: null, held: null };
  if (held) return stillOpen(held, rows) && held.viewer === viewer
    ? { action: "restore", snapshot: held, held: null }
    : { action: "discard", snapshot: null, held: null };
  return { action: "none", snapshot: null, held: null };
}
