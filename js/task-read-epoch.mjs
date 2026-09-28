// Identity verification is a new read epoch. Any board request from an older
// epoch must lose, even if it finishes after verification fails.
export function invalidateTaskRead(view, status, message = null) {
  view.sequence += 1;
  view.status = status;
  view.rows = [];
  view.message = message;
  return view.sequence;
}

export function isCurrentTaskRead(view, sequence) {
  return sequence === view.sequence;
}
