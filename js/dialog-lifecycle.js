// Native close events are queued. An earlier close must not clear a reopened dialog.
export function onDialogClosed(dialog, cleanup) {
  const closed = event => { if (!dialog.open) cleanup(event); };
  dialog?.addEventListener('close', closed);
  return () => dialog?.removeEventListener('close', closed);
}
