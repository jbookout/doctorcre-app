import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialFreeEnv } from './release-environment.mjs';

// Both release lanes use this runner. Provider identity and credential routing
// stay together; no PATH/npx lookup can select the executable receiving a token.
export function providerRelease() {
  const cwd = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  let entry;
  try {
    const json = path => JSON.parse(readFileSync(path, 'utf8'));
    const pkg = json(resolve(cwd, 'package.json'));
    const lock = json(resolve(cwd, 'package-lock.json'));
    const locked = lock.packages['node_modules/wrangler'];
    const directory = resolve(cwd, 'node_modules/wrangler');
    const metadata = resolve(directory, 'package.json');
    const installed = json(metadata);
    if (!locked?.version || pkg.devDependencies.wrangler !== locked.version
      || lock.packages[''].devDependencies.wrangler !== locked.version
      || installed.name !== 'wrangler' || installed.version !== locked.version
      || typeof locked.bin?.wrangler !== 'string' || typeof installed.bin?.wrangler !== 'string') throw new Error('version/bin mismatch');
    entry = resolve(directory, locked.bin.wrangler);
    const within = relative(directory, entry);
    if (within.startsWith('..') || isAbsolute(within)
      || resolve(directory, installed.bin.wrangler) !== entry
      || realpathSync(directory) !== directory || realpathSync(metadata) !== metadata
      || realpathSync(entry) !== entry || !statSync(entry).isFile()) throw new Error('external/missing entrypoint');
  } catch {
    throw new Error('publication requires checkout-local locked Wrangler; run npm ci');
  }
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('publication requires CLOUDFLARE_API_TOKEN');
  const env = { ...credentialFreeEnv(), CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, NO_COLOR: '1' };
  return (args, { capture = false, allowFailure = false } = {}) => {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
    });
    if (result.error) throw result.error;
    if (allowFailure) return result;
    if (result.status !== 0) throw new Error(`Wrangler failed (${result.signal || result.status})`);
    return result.stdout;
  };
}
