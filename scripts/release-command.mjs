import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { credentialFreeEnv } from './release-environment.mjs';
import { providerRelease } from './provider-release.mjs';
import { uploadedVersionId } from './provider-version.mjs';

try {
  const { command, args } = JSON.parse(readFileSync(0, 'utf8'));
  const result = command === 'uploaded-version'
    ? { status: 0, stdout: uploadedVersionId(args[0]) }
    : command === 'provider'
    ? providerRelease()(args, { capture: true, allowFailure: true })
    : spawnSync(command, args, { cwd: new URL('../', import.meta.url),
      env: credentialFreeEnv(), encoding: 'utf8', stdio: 'pipe' });
  process.stdout.write(JSON.stringify({ status: result.status, signal: result.signal,
    stdout: result.stdout || '', stderr: result.stderr || '',
    error: result.error ? 'command could not start' : undefined }));
} catch (error) {
  const known = ['publication requires checkout-local locked Wrangler; run npm ci',
    'publication requires CLOUDFLARE_API_TOKEN', 'Cloudflare returned no unique Worker Version ID'];
  process.stdout.write(JSON.stringify({ status: 1,
    error: known.includes(error.message) ? error.message : 'command could not start' }));
}
