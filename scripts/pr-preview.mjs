import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { credentialFreeEnv } from './release-environment.mjs';

// Fixture-only PR previews, run by hand on the machine where Wrangler is logged
// in. Hosted CI never holds Cloudflare credentials. Each PR gets its own Worker
// (doctorcre-app-pr-<number>) with the static assets and src/preview-worker.js
// only: no service binding, secret, route or production data.
//   npm run preview:pr -- <PR#> [--dry-run]
//   npm run preview:clean [-- <PR#>] [--dry-run]    (no number: every closed PR)
const root = fileURLToPath(new URL('../', import.meta.url));
const MARK = '<!-- doctorcre-pr-preview -->';
export const workerName = number => `doctorcre-app-pr-${number}`;

export function previewConfig(base, name, sha) {
  const { account_id, compatibility_date, compatibility_flags, version_metadata, assets } = base;
  return { name, main: 'src/preview-worker.js', account_id, compatibility_date, compatibility_flags,
    workers_dev: true, preview_urls: false, assets, version_metadata, vars: { GIT_SHA: sha } };
}

export const liveComment = (url, sha) => `${MARK}
**PR preview** (synthetic fixture data only, no production access): ${url}

Built from \`${sha}\`. Updated each time the preview is redeployed; removed when the PR closes.`;
export const removedComment = () => `${MARK}\nPreview removed.`;

const run = (command, args, { cwd = root, env = process.env, capture = false } = {}) =>
  execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
const gh = (...args) => run('gh', args, { capture: true }).trim();
const repo = () => gh('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner');

// The one owned comment on a PR: first one that starts with MARK and was written by us.
function ownComment(slug, number) {
  const me = gh('api', 'user', '-q', '.login');
  const found = gh('api', '--paginate', `repos/${slug}/issues/${number}/comments`, '-q',
    `.[] | select(.user.login == "${me}" and (.body | startswith("${MARK}"))) | [.id, (.body | contains("Preview removed"))] | @tsv`);
  const [id, removed] = found.split('\n')[0]?.split('\t') ?? [];
  return id ? { id, removed: removed === 'true' } : null;
}

function upsertComment(slug, number, body) {
  const own = ownComment(slug, number);
  if (own) gh('api', '-X', 'PATCH', `repos/${slug}/issues/comments/${own.id}`, '-f', `body=${body}`);
  else gh('api', `repos/${slug}/issues/${number}/comments`, '-f', `body=${body}`);
}

const wranglerIn = dir => (args, options = {}) => run(process.execPath, [join(dir, 'node_modules/wrangler/bin/wrangler.js'), ...args],
  { cwd: dir, env: { ...credentialFreeEnv(), NO_COLOR: '1' }, ...options });

function deploy(number, dryRun) {
  const slug = repo();
  const pr = JSON.parse(gh('pr', 'view', number, '--json', 'state,headRefOid,isCrossRepository'));
  if (pr.state !== 'OPEN') throw new Error(`PR ${number} is ${pr.state}; previews are for open PRs`);
  // The build runs the PR's code next to a logged-in Wrangler; only our own branches qualify.
  if (pr.isCrossRepository) throw new Error(`PR ${number} comes from a fork; refusing to build it here`);
  const sha = pr.headRefOid;
  run('git', ['fetch', '--quiet', 'origin', `pull/${number}/head`]);
  if (run('git', ['rev-parse', 'FETCH_HEAD'], { capture: true }).trim() !== sha) throw new Error('the PR moved while fetching; run it again');

  const dir = mkdtempSync(join(tmpdir(), `doctorcre-pr-${number}-`));
  run('git', ['worktree', 'add', '--detach', '--quiet', dir, sha]);
  try {
    copyFileSync(join(root, 'src/preview-worker.js'), join(dir, 'src/preview-worker.js'));
    const clean = { cwd: dir, env: credentialFreeEnv() };
    run('npm', ['ci', '--no-audit', '--no-fund'], clean);
    run('npm', ['run', 'build'], { ...clean, env: { ...clean.env, DOCTORCRE_SOURCE_COMMIT: sha } });
    const name = workerName(number);
    writeFileSync(join(dir, 'wrangler.preview.json'),
      JSON.stringify(previewConfig(JSON.parse(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')), name, sha), null, 2));
    const out = wranglerIn(dir)(['deploy', '--config', 'wrangler.preview.json', ...(dryRun ? ['--dry-run'] : [])], { capture: true });
    process.stdout.write(out);
    if (dryRun) { console.log(`\n[dry run] would post on PR ${number}:\n${liveComment(`https://${name}.<subdomain>.workers.dev`, sha)}`); return; }
    const url = out.match(new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev`))?.[0];
    if (!url) throw new Error('deployed, but Wrangler printed no workers.dev URL');
    upsertComment(slug, number, liveComment(url, sha));
    console.log(`\npreview: ${url}`);
  } finally {
    run('git', ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

function clean(number, dryRun) {
  const slug = repo();
  const numbers = number ? [number]
    : JSON.parse(gh('pr', 'list', '--state', 'closed', '--limit', '100', '--json', 'number')).map(pr => String(pr.number));
  for (const n of numbers) {
    const own = ownComment(slug, n);
    if (!own || own.removed) { if (number) console.log(`PR ${n}: no live preview comment`); continue; }
    // Wrangler runs from the checkout's locked install; delete needs no PR build.
    wranglerIn(root)(['delete', workerName(n), '--force', ...(dryRun ? ['--dry-run'] : [])]);
    if (!dryRun) gh('api', '-X', 'PATCH', `repos/${slug}/issues/comments/${own.id}`, '-f', `body=${removedComment()}`);
    console.log(`PR ${n}: ${dryRun ? 'would remove' : 'removed'} ${workerName(n)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes('--dry-run');
  const number = rest.find(arg => /^\d+$/.test(arg));
  if (command === 'deploy' && number) deploy(number, dryRun);
  else if (command === 'clean') clean(number, dryRun);
  else { console.error('usage: pr-preview.mjs deploy <PR#> [--dry-run] | clean [<PR#>] [--dry-run]'); process.exit(2); }
}
