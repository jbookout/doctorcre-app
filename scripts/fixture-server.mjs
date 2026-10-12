import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Starts scripts/serve.mjs on an OS-picked port. The exit promise exists before
// startup can fail, so a server that dies early is reaped instead of awaited
// forever, and stop() is bounded even when the child ignores SIGTERM.
export async function startFixtureServer({ args = ['scripts/serve.mjs'], env = {}, startupMs = 15000, stopMs = 5000 } = {}) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const running = () => child.exitCode === null && child.signalCode === null;
  const stop = async () => {
    if (running()) child.kill('SIGTERM');
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(resolve, stopMs, 'late'); });
    if (await Promise.race([exited, late]) === 'late') { child.kill('SIGKILL'); await exited; }
    clearTimeout(timer);
  };
  let timer;
  try {
    const url = await Promise.race([
      new Promise(resolve => {
        let output = '';
        child.stdout.on('data', data => {
          output += data;
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) resolve(match[0]);
        });
      }),
      exited.then(({ code, signal, error }) => { throw Error(`fixture server exited ${error?.message ?? code ?? signal}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture server startup timeout')), startupMs); }),
    ]);
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
