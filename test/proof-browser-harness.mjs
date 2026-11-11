import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

export function ownedBrowserProcesses(root, ownerPid) {
  assert.ok(root);
  const snapshot = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(snapshot.status, 0, 'owned process snapshot must succeed');
  const processes = snapshot.stdout.split('\n')
    .map(line => { const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/); return match && { pid: Number(match[1]), parent: Number(match[2]), command: match[3] }; }).filter(process => process && process.pid !== snapshot.pid);
  const owned = new Set(processes.filter(process => process.command.includes(root)).map(process => process.pid));
  if (ownerPid) owned.add(ownerPid);
  let changed;
  do {
    changed = false;
    for (const process of processes) if (owned.has(process.parent) && !owned.has(process.pid)) { owned.add(process.pid); changed = true; }
  } while (changed);
  return [...owned];
}

export async function assertProofDeadlineCleanup(t, { entry, args, mode, timeoutMs = 5000, acquisitionDelayMs = 0, evaluationTarget = 'page' }) {
  assert.ok(['late launch', 'stalled evaluation'].includes(mode));
  const proofTimeoutMs = mode === 'stalled evaluation' ? 30000 : timeoutMs;
  const root = temporaryDirectory('proof-browser-fault-', t);
  const diagnostics = join(root, 'diagnostics.json');
  const preload = `
    import { writeFileSync } from 'node:fs';
    import { ownedBrowserProcesses } from ${JSON.stringify(import.meta.url)};
    const { chromium } = await import(${JSON.stringify(import.meta.resolve('playwright'))});
    const launch = chromium.launch.bind(chromium);
    const state = { acquired: false, disconnected: false, evaluating: false, pids: [] };
    const save = () => { if (state.directory) state.pids = [...new Set([...state.pids, ...ownedBrowserProcesses(state.directory, process.pid)])]; writeFileSync(${JSON.stringify(diagnostics)}, JSON.stringify(state)); };
    const realSetTimeout = globalThis.setTimeout;
    let deadline;
    if (${JSON.stringify(mode)} === 'stalled evaluation') {
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay !== ${proofTimeoutMs}) return realSetTimeout(callback, delay, ...args);
        globalThis.setTimeout = realSetTimeout;
        const timer = realSetTimeout(callback, delay, ...args);
        deadline = () => {
          clearTimeout(timer);
          state.deadlineArmed = true;
          realSetTimeout(() => { state.deadlineTriggered = true; save(); callback(...args); }, ${timeoutMs});
        };
        return timer;
      };
    }
    chromium.launch = async options => {
      state.directory = options.env.TMPDIR;
      save();
      const browser = await launch({ ...options, timeout: 10000 });
      state.acquired = true;
      browser.on('disconnected', () => { state.disconnected = true; save(); });
      save();
      if (${JSON.stringify(mode)} === 'late launch') await new Promise(resolve => setTimeout(resolve, ${timeoutMs + 300}));
      else {
        const newPage = browser.newPage.bind(browser);
        browser.newPage = async (...args) => {
          const page = await newPage(...args);
          await new Promise(resolve => setTimeout(resolve, ${acquisitionDelayMs}));
          const stall = () => {
            state.evaluating = true;
            if (!deadline) throw Error('Proof deadline timer was not captured');
            deadline();
            save();
            return new Promise(() => {});
          };
          if (${JSON.stringify(evaluationTarget)} === 'locator') {
            const locator = page.locator('html');
            Object.getPrototypeOf(locator).evaluate = stall;
          } else if (${JSON.stringify(evaluationTarget)} === 'locatorAll') {
            const locator = page.locator('html');
            Object.getPrototypeOf(locator).evaluateAll = stall;
          } else page.evaluate = stall;
          return page;
        };
      }
      return browser;
    };
  `;
  const preloadPath = join(root, 'preload.mjs');
  await writeFile(preloadPath, preload);
  let child, watchdog;
  try {
    const result = await new Promise((resolveResult, reject) => {
      child = spawn(process.execPath, ['--import', preloadPath, resolve(entry), ...args, '--timeout-ms', String(proofTimeoutMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => stdout += chunk);
      child.stderr.on('data', chunk => stderr += chunk);
      child.once('error', reject);
      child.once('close', code => resolveResult({ code, stdout, stderr }));
      watchdog = setTimeout(() => reject(Error(`Proof child did not exit: ${stderr}`)), timeoutMs + 15000);
    });
    const state = JSON.parse(await readFile(diagnostics, 'utf8'));
    const survivors = [...new Set([...ownedBrowserProcesses(state.directory), ...state.pids.filter(pid => {
      try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    })])];
    t.diagnostic(JSON.stringify({ mode, exit: result.code, survivors, ...state }));
    assert.equal(result.code, 78, result.stderr);
    assert.equal(state.acquired, true);
    assert.ok(state.pids.length > 1, 'must observe owned browser process IDs before closure');
    assert.equal(state.disconnected, true);
    if (mode === 'stalled evaluation') {
      assert.equal(state.evaluating, true);
      assert.equal(state.deadlineArmed, true);
      assert.equal(state.deadlineTriggered, true);
    }
    assert.deepEqual(survivors, [], 'zero surviving owned browser processes');
    return result;
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('close', resolve));
    }
    // A failed assertion must still dispose only this run's recorded resources.
    const state = await readFile(diagnostics, 'utf8').then(JSON.parse).catch(() => null);
    if (state?.directory) for (const pid of new Set([...state.pids, ...ownedBrowserProcesses(state.directory)])) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}
