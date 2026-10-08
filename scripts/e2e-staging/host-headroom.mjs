// Host headroom checks run before a live run opens its authorization and
// again inside the run. The local Qwen Flash server occupies a large share of
// unified memory and can starve the browser, so a run refuses while it listens
// on its loopback port (IPv4 or IPv6), while that probe cannot finish, or while
// free plus inactive memory is below the profile's floor. Every probe stays on
// this machine: loopback TCP connects and one `vm_stat` read.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUDGET_DIR, BudgetRefusal, openRunBudget, readAuthorization } from './run-budget.mjs';

export const LOCAL_MODEL_PORT = 8000;
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1']);

export function parseVmStat(text) {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = name => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(text)?.[1]);
  const bytes = (pages('free') + pages('inactive')) * page;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('vm_stat output was not understood');
  return bytes;
}

// One connect attempt: 'open', 'closed' (refused), 'timeout' or 'error'.
export function portStatus(port, host, { timeoutMs = 500, connect = netConnect } = {}) {
  return new Promise(resolve => {
    const socket = connect({ port, host });
    let settled = false;
    const done = status => { if (settled) return; settled = true; socket.destroy(); resolve(status); };
    socket.setTimeout(timeoutMs, () => done('timeout'));
    socket.once('connect', () => done('open'));
    socket.once('error', error => done(error?.code === 'ECONNREFUSED' ? 'closed' : 'error'));
  });
}

export async function portListening(port, host = '127.0.0.1', timeoutMs = 500) {
  return (await portStatus(port, host, { timeoutMs })) === 'open';
}

// The model port counts as free only when every loopback address refuses the
// connection outright. A timeout or an unexpected error is not proof of absence.
export async function localModelPortStatus({ port = LOCAL_MODEL_PORT, hosts = LOOPBACK_HOSTS, timeoutMs = 500, connect } = {}) {
  const statuses = await Promise.all(hosts.map(host => portStatus(port, host, { timeoutMs, connect })));
  for (const status of ['open', 'timeout', 'error']) if (statuses.includes(status)) return status;
  return 'closed';
}

export const HOST_PROBE = Object.freeze({
  portOpen: () => localModelPortStatus(),
  freeInactiveBytes: () => new Promise((resolve, reject) => execFile('vm_stat', { timeout: 5_000 }, (error, stdout) => {
    if (error) return reject(new Error('vm_stat unavailable'));
    try { resolve(parseVmStat(stdout)); } catch (parseError) { reject(parseError); }
  })),
});

const PORT_CAUSES = { open: 'local-model-port-listening', true: 'local-model-port-listening', timeout: 'local-model-probe-timeout', error: 'local-model-probe-failed' };

// Returns null when the run may proceed, otherwise the refusal cause. A probe
// or memory reading that fails is treated as insufficient headroom.
export async function localModelHeadroom({ floorBytes, probe = HOST_PROBE }) {
  let port;
  try { port = await probe.portOpen(); } catch { port = 'error'; }
  if (port !== false && port !== 'closed') return { cause: PORT_CAUSES[String(port)] || 'local-model-probe-failed', port: LOCAL_MODEL_PORT };
  let free;
  try { free = await probe.freeInactiveBytes(); } catch { return { cause: 'memory-unreadable', floor_bytes: floorBytes }; }
  if (!(free >= floorBytes)) return { cause: 'memory-below-floor', free_inactive_bytes: free, floor_bytes: floorBytes };
  return null;
}

async function recordRefusal(dir, receipt) {
  const folder = join(dir, 'refusals');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
  const handle = await open(join(folder, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
}

// The one way a live entry point opens its budget: confirm the authorization
// read-only, check host headroom, and only then open (which starts the run's
// clock). A crowded host writes a refusal receipt and leaves the
// authorization unspent.
export async function openWithHeadroom({ dir = BUDGET_DIR, profile, host = HOST_PROBE, clock } = {}) {
  const authorized = await readAuthorization({ dir, profile });
  const crowded = await localModelHeadroom({ floorBytes: authorized.profile.memoryFloorBytes, probe: host });
  if (crowded) {
    await recordRefusal(dir, { schema: 'e2e-headroom-refusal.v1', code: 'local_model_resident', run_id: authorized.run_id,
      profile: authorized.profile.name, at: new Date().toISOString(), ...crowded });
    const refusal = new BudgetRefusal('local_model_resident');
    refusal.detail = crowded;
    throw refusal;
  }
  return openRunBudget({ dir, profile, clock });
}
