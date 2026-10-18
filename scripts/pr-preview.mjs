import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { credentialFreeEnv } from './release-environment.mjs';

// PR code runs only in hosted CI. Locally, download static assets and deploy
// them with main's Worker, config and lockfile-pinned Wrangler.
export const REPO = 'jbookout/doctorcre-app';
const root = fileURLToPath(new URL('../', import.meta.url));
const MARK = '<!-- doctorcre-pr-preview -->';
const SITE_LIMITS = { files: 5000, bytes: 200 * 1024 * 1024 };
export const workerName = number => `doctorcre-app-pr-${number}`;

export const prNumber = value => {
  const text = String(value);
  const number = /^\d{1,9}$/.test(text) ? String(Number(text)) : '0';
  if (number === '0') throw new Error(`not a PR number: ${text}`);
  return number;
};

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'deploy' && command !== 'clean') throw new Error(`unknown command: ${command ?? '(none)'}`);
  let dryRun = false;
  let number = null;
  for (const arg of rest) {
    if (arg === '--dry-run') dryRun = true;
    else if (/^\d+$/.test(arg) && number === null) number = prNumber(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (command === 'deploy' && number === null) throw new Error('deploy needs a PR number');
  return { command, number, dryRun };
}

export function previewConfig(base, name, sha) {
  const { account_id, compatibility_date, compatibility_flags } = base;
  return { name, main: 'src/preview-worker.js', account_id, compatibility_date, compatibility_flags,
    workers_dev: true, preview_urls: false,
    assets: { directory: './dist/site', binding: 'ASSETS', run_worker_first: true },
    version_metadata: { binding: 'CF_VERSION_METADATA' }, vars: { GIT_SHA: sha } };
}

export function cleanTargets(prs, number = null) {
  const closed = prs.filter(pr => pr.state !== 'OPEN').map(pr => String(pr.number));
  if (number === null) return closed;
  if (!closed.includes(number)) throw new Error(`PR ${number} is open or unknown; previews are only removed for closed or merged PRs`);
  return [number];
}

export const liveComment = (url, sha) => `${MARK}
**PR preview** (synthetic fixture data only, no production access): ${url}

Built from \`${sha}\`. Updated each time the preview is redeployed; removed when the PR closes.`;
export const removedComment = () => `${MARK}\nPreview removed.`;

export function checkedSiteFiles(siteDir, limits = SITE_LIMITS) {
  const top = lstatSync(siteDir);
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Error('build output dist/site must be a real directory');
  const base = resolve(siteDir);
  const files = [];
  let bytes = 0;
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(base, path);
      if (rel.startsWith('..') || rel.split(sep).includes('..')) throw new Error(`build output escapes dist/site: ${rel}`);
      if (entry.name.startsWith('.')) throw new Error(`build output has a dotfile: ${rel}`);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`build output has a symlink: ${rel}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        bytes += stat.size;
        files.push(rel);
        if (files.length > limits.files || bytes > limits.bytes) throw new Error('build output is larger than a fixture preview should be');
      } else throw new Error(`build output has a non-regular file: ${rel}`);
    }
  };
  walk(base);
  if (!files.length) throw new Error('build output dist/site is empty');
  return files;
}

const run = (command, args, { cwd = root, env = process.env, capture = false } = {}) =>
  execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
const gh = (...args) => run('gh', [...args], { capture: true }).trim();
const ghPr = (...args) => gh(...args, '-R', REPO);
const git = (...args) => run('git', args, { capture: true }).trim();

function assertRunningFromMain() {
  const origin = git('config', '--get', 'remote.origin.url');
  if (!new RegExp(`^(https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)${REPO}(\\.git)?$`).test(origin)) {
    throw new Error(`origin is ${origin}, not ${REPO}; run this from a checkout of ${REPO}`);
  }
  run('git', ['fetch', '--quiet', 'origin', 'main']);
  const head = git('rev-parse', 'HEAD');
  const main = git('rev-parse', 'origin/main');
  if (head !== main) throw new Error(`this checkout is at ${head.slice(0, 12)}, not origin/main ${main.slice(0, 12)}; check out main, pull, and run again`);
  // Untracked files cannot replace what runs here (the staging sources come from git, not the working tree).
  if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('this checkout has uncommitted changes to tracked files; run from a clean main');
  return head;
}

export function pinnedWrangler(trustedRoot = root) {
  const wanted = JSON.parse(readFileSync(join(trustedRoot, 'package-lock.json'), 'utf8')).packages['node_modules/wrangler'].version;
  const have = JSON.parse(readFileSync(join(trustedRoot, 'node_modules/wrangler/package.json'), 'utf8')).version;
  const binary = realpathSync(join(trustedRoot, 'node_modules/wrangler/bin/wrangler.js'));
  if (have !== wanted || !binary.startsWith(realpathSync(trustedRoot) + sep))
    throw new Error('Wrangler must come from this main checkout at its lockfile-pinned version; run npm ci here first');
  return binary;
}

const wrangler = (args, { cwd = root, capture = false } = {}) => run(process.execPath,
  [pinnedWrangler(), ...args], { cwd, env: { ...credentialFreeEnv(), NO_COLOR: '1' }, capture });

export function downloadPreview(number, sha, directory, ghCall = gh) {
  const [run] = JSON.parse(ghCall('run', 'list', '--repo', REPO, '--workflow', 'ci.yml',
    '--commit', sha, '--event', 'pull_request', '--limit', '1', '--json', 'databaseId,headSha,status,conclusion'));
  if (!run || run.headSha !== sha || run.status !== 'completed' || run.conclusion !== 'success')
    throw new Error('preview needs the exact head SHA in a completed-success CI run');
  ghCall('run', 'download', String(run.databaseId), '--repo', REPO,
    '--name', `pr-preview-${number}-${sha}`, '--dir', directory);
}

function deploy(number, dryRun) {
  const head = assertRunningFromMain();
  const pr = JSON.parse(ghPr('pr', 'view', number, '--json', 'state,headRefOid,isCrossRepository'));
  if (pr.state !== 'OPEN') throw new Error(`PR ${number} is ${pr.state}; previews are for open PRs`);
  if (pr.isCrossRepository) throw new Error(`PR ${number} comes from a fork; previews require same-repository PRs`);
  const sha = pr.headRefOid;

  const scratch = mkdtempSync(join(tmpdir(), `doctorcre-pr-${number}-`));
  const stage = join(scratch, 'stage');
  const site = join(stage, 'dist/site');
  mkdirSync(site, { recursive: true });
  try {
    downloadPreview(number, sha, site);
    checkedSiteFiles(site);
    execFileSync('tar', ['-x', '-C', stage], { input: execFileSync('git', ['archive', '--format=tar', head, 'src/preview-worker.js', 'src/worker.js', 'js', 'contracts'], { cwd: root, maxBuffer: 1 << 30 }) });
    const name = workerName(number);
    writeFileSync(join(stage, 'wrangler.json'),
      JSON.stringify(previewConfig(JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')), name, sha), null, 2));

    const out = wrangler(['deploy', '--config', 'wrangler.json', ...(dryRun ? ['--dry-run'] : [])], { cwd: stage, capture: true });
    process.stdout.write(out);
    if (dryRun) { console.log(`\n[dry run] would post on PR ${number}:\n${liveComment(`https://${name}.<subdomain>.workers.dev`, sha)}`); return; }
    const url = out.match(new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev`))?.[0];
    if (!url) throw new Error('deployed, but Wrangler printed no workers.dev URL');
    upsertComment(number, liveComment(url, sha));
    console.log(`\npreview: ${url}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function ownComment(number) {
  const me = gh('api', 'user', '-q', '.login');
  const found = gh('api', '--paginate', `repos/${REPO}/issues/${number}/comments`, '-q',
    `.[] | select(.user.login == "${me}" and (.body | startswith("${MARK}"))) | [.id, (.body | contains("Preview removed"))] | @tsv`);
  const [id, removed] = found.split('\n')[0]?.split('\t') ?? [];
  return id ? { id, removed: removed === 'true' } : null;
}

function upsertComment(number, body) {
  const own = ownComment(number);
  if (own) gh('api', '-X', 'PATCH', `repos/${REPO}/issues/comments/${own.id}`, '-f', `body=${body}`);
  else gh('api', `repos/${REPO}/issues/${number}/comments`, '-f', `body=${body}`);
}

function clean(number, dryRun) {
  assertRunningFromMain();
  const prs = JSON.parse(ghPr('pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,state'));
  for (const n of cleanTargets(prs, number)) {
    const own = ownComment(n);
    if (!own || own.removed) { if (number) console.log(`PR ${n}: no live preview comment`); continue; }
    wrangler(['delete', workerName(n), '--force', ...(dryRun ? ['--dry-run'] : [])]);
    if (!dryRun) gh('api', '-X', 'PATCH', `repos/${REPO}/issues/comments/${own.id}`, '-f', `body=${removedComment()}`);
    console.log(`PR ${n}: ${dryRun ? 'would remove' : 'removed'} ${workerName(n)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let parsed;
  try { parsed = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(`${error.message}\nusage: pr-preview.mjs deploy <PR#> [--dry-run] | clean [<PR#>] [--dry-run]`);
    process.exit(2);
  }
  try {
    if (parsed.command === 'deploy') deploy(parsed.number, parsed.dryRun);
    else clean(parsed.number, parsed.dryRun);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
