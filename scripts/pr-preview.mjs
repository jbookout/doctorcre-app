import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { credentialFreeEnv } from './release-environment.mjs';

// Fixture-only PR previews, run by hand on the machine where Wrangler is logged
// in. Hosted CI never holds Cloudflare credentials. Each PR gets its own Worker
// (doctorcre-app-pr-<number>) with the static assets and main's
// src/preview-worker.js only: no service binding, secret, route or production data.
//   npm run preview:pr -- <PR#> [--dry-run]
//   npm run preview:clean [-- <PR#>] [--dry-run]   (no number: every non-open PR)
//
// Trust model. The PR's code runs only in the build step, with a throwaway HOME,
// the credential-free environment, no lifecycle scripts at install, and (on macOS)
// a sandbox that blocks the network during the build and hides Wrangler's login
// directory. The only credentialed step is Wrangler from THIS checkout's locked
// install, deploying a fresh staging directory that holds the checked build
// output, main's Worker sources and a config generated from main's wrangler.jsonc.
// So this script refuses to run unless this checkout is clean main at origin/main.
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

// Everything that shapes the Worker comes from main (`base` is main's parsed
// wrangler.jsonc) or is fixed here. Nothing is read from the PR: no account id,
// no path, no binding.
export function previewConfig(base, name, sha) {
  const { account_id, compatibility_date, compatibility_flags } = base;
  return { name, main: 'src/preview-worker.js', account_id, compatibility_date, compatibility_flags,
    workers_dev: true, preview_urls: false,
    assets: { directory: './dist/site', binding: 'ASSETS', run_worker_first: true },
    version_metadata: { binding: 'CF_VERSION_METADATA' }, vars: { GIT_SHA: sha } };
}

// Cleanup targets: PRs that are no longer open. A single named PR must also be non-open.
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

// The PR's build output is data, never code: only regular files under one real
// directory, no links, no dotfiles, bounded size.
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

function copySite(from, to) {
  for (const rel of checkedSiteFiles(from)) {
    mkdirSync(dirname(join(to, rel)), { recursive: true });
    copyFileSync(join(from, rel), join(to, rel));
  }
}

const run = (command, args, { cwd = root, env = process.env, capture = false } = {}) =>
  execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
const gh = (...args) => run('gh', [...args], { capture: true }).trim();
const ghPr = (...args) => gh(...args, '-R', REPO);
const git = (...args) => run('git', args, { capture: true }).trim();

// This checkout is the trusted code: it must be the repository's own main.
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

function assertPinnedWrangler() {
  const wanted = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies.wrangler;
  const have = JSON.parse(readFileSync(join(root, 'node_modules/wrangler/package.json'), 'utf8')).version;
  if (have !== wanted) throw new Error(`installed Wrangler ${have} is not the pinned ${wanted}; run npm ci here first`);
}

// The ONLY credentialed step. Wrangler is this checkout's, never the PR's.
const wrangler = (args, { cwd = root, capture = false } = {}) => run(process.execPath,
  [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args],
  { cwd, env: { ...credentialFreeEnv(), NO_COLOR: '1' }, capture });

// macOS sandbox for PR code: Wrangler's login lives under the real HOME, which a
// throwaway HOME alone does not hide from absolute paths. Deny those reads, and
// the network once dependencies are installed.
function sandboxProfile(realHome, network) {
  const hidden = ['Library/Preferences/.wrangler', '.wrangler', '.config/.wrangler', '.config/gh', '.ssh', '.aws', '.npmrc', '.netrc', 'Library/Keychains']
    .map(path => `(subpath ${JSON.stringify(join(realHome, path))})`).join(' ');
  return `(version 1)(allow default)${network ? '' : '(deny network*)'}(deny file-read* ${hidden})`;
}

function confined(home, command, args, { cwd, env, network }) {
  const profile = join(home, 'confine.sb');
  if (process.platform === 'darwin') {
    writeFileSync(profile, sandboxProfile(process.env.HOME, network));
    return run('/usr/bin/sandbox-exec', ['-f', profile, command, ...args], { cwd, env });
  }
  console.warn('warning: no sandbox on this platform; PR code runs with the throwaway HOME only');
  return run(command, args, { cwd, env });
}

function deploy(number, dryRun) {
  const head = assertRunningFromMain();
  assertPinnedWrangler();
  const pr = JSON.parse(ghPr('pr', 'view', number, '--json', 'state,headRefOid,isCrossRepository'));
  if (pr.state !== 'OPEN') throw new Error(`PR ${number} is ${pr.state}; previews are for open PRs`);
  // The build runs the PR's code on this machine; only our own branches qualify.
  if (pr.isCrossRepository) throw new Error(`PR ${number} comes from a fork; refusing to build it here`);
  const sha = pr.headRefOid;
  run('git', ['fetch', '--quiet', 'origin', `pull/${number}/head`]);
  if (git('rev-parse', 'FETCH_HEAD') !== sha) throw new Error('the PR moved while fetching; run it again');

  const scratch = mkdtempSync(join(tmpdir(), `doctorcre-pr-${number}-`));
  const home = join(scratch, 'home');
  const work = join(scratch, 'work');
  const stage = join(scratch, 'stage');
  for (const dir of [home, join(home, 'tmp'), work, stage]) mkdirSync(dir, { recursive: true });
  try {
    // PR sources as plain files: no .git, so the build cannot reach this repository.
    execFileSync('tar', ['-x', '-C', work], { input: execFileSync('git', ['archive', '--format=tar', sha], { cwd: root, maxBuffer: 1 << 30 }) });
    rmSync(join(work, '.npmrc'), { force: true });
    writeFileSync(join(home, 'npmrc-user'), '');
    writeFileSync(join(home, 'npmrc-global'), '');
    const env = { ...credentialFreeEnv(), HOME: home, TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, 'config'),
      npm_config_userconfig: join(home, 'npmrc-user'), npm_config_globalconfig: join(home, 'npmrc-global'), NO_COLOR: '1' };
    confined(home, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: work, env, network: true });
    confined(home, 'npm', ['run', 'build'], { cwd: work, env: { ...env, DOCTORCRE_SOURCE_COMMIT: sha }, network: false });

    // Fresh staging directory: checked build output + main's Worker sources + generated config.
    copySite(join(work, 'dist/site'), join(stage, 'dist/site'));
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

// The one owned comment on a PR: first one that starts with MARK and was written by us.
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
  assertPinnedWrangler();
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
