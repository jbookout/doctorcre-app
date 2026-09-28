/**
 * A resumed read may advance the current version while a person still holds
 * fields typed against an older one. Keep that draft's base for the record
 * layer's compare-and-swap. An untouched form uses the current read.
 */
export function preferenceSaveView(currentView, draftBaseVersion) {
  if (!currentView) return null;
  return Number.isInteger(draftBaseVersion) && draftBaseVersion > 0
    ? { ...currentView, version: draftBaseVersion }
    : currentView;
}
