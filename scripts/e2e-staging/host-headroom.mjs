// Host headroom checks run before a live run starts. The local Qwen Flash
// server occupies a large share of unified memory and can starve the browser,
// so a run refuses while it listens on its loopback port or while free plus
// inactive memory is below the profile's floor. Both probes stay on this
// machine: one loopback TCP connect and one `vm_stat` read.
import { execFile } from 'node:child_process';
import { connect } from 'node:net';

export const LOCAL_MODEL_PORT = 8000;

export function parseVmStat(text) {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = name => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(text)?.[1]);
  const bytes = (pages('free') + pages('inactive')) * page;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('vm_stat output was not understood');
  return bytes;
}

export function portListening(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise(resolve => {
    const socket = connect({ port, host });
    const done = open => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export const HOST_PROBE = Object.freeze({
  portOpen: () => portListening(LOCAL_MODEL_PORT),
  freeInactiveBytes: () => new Promise((resolve, reject) => execFile('vm_stat', { timeout: 5_000 }, (error, stdout) => {
    if (error) return reject(new Error('vm_stat unavailable'));
    try { resolve(parseVmStat(stdout)); } catch (parseError) { reject(parseError); }
  })),
});

// Returns null when the run may start, otherwise the refusal cause. A memory
// reading that fails is treated as insufficient headroom.
export async function localModelHeadroom({ floorBytes, probe = HOST_PROBE }) {
  if (await probe.portOpen()) return { cause: 'local-model-port-listening', port: LOCAL_MODEL_PORT };
  let free;
  try { free = await probe.freeInactiveBytes(); } catch { return { cause: 'memory-unreadable', floor_bytes: floorBytes }; }
  if (!(free >= floorBytes)) return { cause: 'memory-below-floor', free_inactive_bytes: free, floor_bytes: floorBytes };
  return null;
}
