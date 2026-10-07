import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { providerRelease } from './provider-release.mjs';
import { credentialFreeEnv } from './release-environment.mjs';
import { uploadedVersionId } from './provider-version.mjs';
import { previewTarget } from './preview-target.mjs';
import { assertServedBuild } from './browser-proof-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = `${root}.e2e/preview/wrangler.json`;
const base = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

function workerName(pr) {
  if (!/^[1-9]\d{0,9}$/.test(String(pr))) throw Error('preview requires a positive PR number');
  return `doctorcre-app-pr-${pr}`;
}

export function previewPlan(pr, sourceCommit, now = new Date()) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw Error('preview requires an exact source commit');
  const name = workerName(pr), alias = `pr-${pr}`;
  return {
    name, alias,
    config: {
      name, account_id: base.account_id, main: `${root}src/preview-worker.js`,
      compatibility_date: base.compatibility_date, compatibility_flags: base.compatibility_flags,
      workers_dev: false, preview_urls: true, routes: [], send_metrics: false,
      assets: { directory: `${root}dist/site`, binding: 'ASSETS', run_worker_first: true },
      version_metadata: { binding: 'CF_VERSION_METADATA' },
      vars: { APP_ENV: 'preview', GIT_SHA: sourceCommit,
        PREVIEW_EXPIRES_AT: new Date(now.valueOf() + 7 * 24 * 60 * 60 * 1000).toISOString() },
    },
    upload: ['versions', 'upload', '--config', configPath, '--strict', '--preview-alias', alias, '--tag', sourceCommit],
  };
}

async function checked(response) {
  if (!response.ok) throw Error(`Cloudflare preview request failed: HTTP ${response.status}`);
  const answer = await response.json();
  if (answer.success !== true) throw Error('Cloudflare preview request refused');
  return answer.result;
}

// Create an undeployed parent: versions upload cannot bootstrap a new Worker.
// The Workers API can do this without a production deployment or route.
export async function ensurePreviewWorker(pr, api) {
  const name = workerName(pr);
  const existing = await api(`/workers/workers/${name}`);
  if (existing.status !== 404) {
    const worker = await checked(existing);
    if (worker.name !== name) throw Error('Cloudflare preview Worker identity mismatch');
    return;
  }
  await checked(await api('/workers/workers', {
    method: 'POST', body: { name, subdomain: { enabled: false, previews_enabled: true } },
  }));
}

export async function deletePreviewWorker(pr, api) {
  const response = await api(`/workers/scripts/${workerName(pr)}`, { method: 'DELETE' });
  if (response.status !== 404) await checked(response);
}

function cloudflareApi() {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw Error('Preview skipped: add repository secret CLOUDFLARE_API_TOKEN');
  return (path, { method = 'GET', body } = {}) => fetch(
    `https://api.cloudflare.com/client/v4/accounts/${base.account_id}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
}

async function main() {
  const [command, pr, sourceCommit] = process.argv.slice(2);
  if (command === 'cleanup') {
    await deletePreviewWorker(pr, cloudflareApi());
    console.log(`Removed ${workerName(pr)} (or already absent)`);
    return;
  }
  if (!['config', 'upload'].includes(command)) throw Error('use config, upload or cleanup');
  const plan = previewPlan(pr, sourceCommit);
  await mkdir(`${root}.e2e/preview`, { recursive: true });
  await writeFile(configPath, JSON.stringify(plan.config, null, 2));
  if (command === 'config') return;
  // Use the release lane's source-bound verification and extraction, so a
  // modified dist/site directory cannot become upload input.
  execFileSync(process.execPath, ['scripts/build-artifact.mjs', 'prepare-deployment'], {
    cwd: root, env: credentialFreeEnv(), stdio: 'inherit',
  });
  const manifestBytes = await readFile(`${root}dist/doctorcre-app.manifest.json`);
  if (JSON.parse(manifestBytes).source_commit !== sourceCommit) throw Error('preview build source mismatch');
  const binding = { sourceCommit, manifestDigest: createHash('sha256').update(manifestBytes).digest('hex') };
  await ensurePreviewWorker(pr, cloudflareApi());
  // Locked Wrangler is the existing credential-routing module. It captures
  // provider output; only validated public IDs/URLs are written below.
  const output = providerRelease()(plan.upload, { capture: true });
  const versionId = uploadedVersionId(output);
  const aliasUrl = previewTarget(output.match(/Version Preview Alias URL:\s*(https:\/\/\S+)/)?.[1]);
  const versionUrl = previewTarget(output.match(/Version Preview URL:\s*(https:\/\/\S+)/)?.[1]);
  if (!new URL(aliasUrl).hostname.startsWith(`${plan.alias}-${plan.name}.`) ||
      !new URL(versionUrl).hostname.startsWith(`${versionId.slice(0, 8)}-${plan.name}.`))
    throw Error('preview URL does not identify this PR/version');
  // Propagation is bounded. Read the uploaded bytes, not Wrangler's success.
  let error;
  for (let attempt = 0; attempt < 12; attempt++) {
    try { await assertServedBuild(versionUrl, binding); error = null; break; }
    catch (caught) { error = caught; await new Promise(resolve => setTimeout(resolve, 5000)); }
  }
  if (error) throw error;
  const receipt = { pr: Number(pr), aliasUrl, versionUrl, versionId, binding,
    expiresAt: plan.config.vars.PREVIEW_EXPIRES_AT };
  await writeFile(`${root}.e2e/preview/receipt.json`, JSON.stringify(receipt, null, 2));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `url=${aliasUrl}\nversion_url=${versionUrl}\nbinding=${JSON.stringify(binding)}\nexpires_at=${receipt.expiresAt}\n`);
  console.log(`Fixture preview: ${aliasUrl}; expires ${receipt.expiresAt}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
