import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { providerRelease } from '../provider-release.mjs';
import { fileURLToPath } from 'node:url';
import { STAGING_ORIGIN } from './session.mjs';
import { assertStagingDeployment } from './deployment.mjs';
import { credentialFreeEnv } from '../release-environment.mjs';

const cwd = fileURLToPath(new URL('../../', import.meta.url));
assertStagingDeployment(JSON.parse(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')));
const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = git(['rev-parse', 'HEAD']);
const supplied = process.argv[process.argv.indexOf('--source-sha') + 1];
if (!process.argv.includes('--source-sha') || supplied !== commit) throw new Error('Staging QA deployment must bind --source-sha to HEAD');
if (!/^[a-f0-9]{40}$/.test(commit) || git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('E2E staging candidate requires exact committed clean source');
for (const operation of ['build', 'prepare-deployment']) {
  execFileSync(process.execPath, ['scripts/build-artifact.mjs', operation], { cwd, env: credentialFreeEnv(), stdio: 'inherit' });
}
const provider = providerRelease();
provider(['deploy', '--env', 'staging', '--strict', '--var', `GIT_SHA:${commit}`, '--message', `E2E staging candidate ${commit}`], { capture: true });
const response = await fetch(`${STAGING_ORIGIN}/app-release`, { redirect: 'error' });
const release = await response.json();
if (release.environment !== 'staging' || release.source_commit !== commit) throw new Error('Staging candidate readback mismatch');
console.log(`DoctorCRE staging candidate verified ${commit}`);
