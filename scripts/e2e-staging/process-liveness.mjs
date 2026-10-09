// macOS can refuse probes/signals to an unreaped zombie. Continue the finite
// cleanup loop and verify disappearance before treating it as terminated.
export function targetExists(target) {
  try { process.kill(target, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export function signalTarget(target, signal) {
  try { process.kill(target, signal); }
  catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
}
