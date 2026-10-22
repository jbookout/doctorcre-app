import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const report = text => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
};

try {
  const { BASE_SHA: base, HEAD_SHA: head } = process.env;
  for (const sha of [base, head]) {
    if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('BASE_SHA and HEAD_SHA must be full commit SHAs');
    git('cat-file', '-e', `${sha}^{commit}`);
  }
  const changed = git('diff', '--name-only', '--no-renames', '--diff-filter=AM', '-z', `${base}...${head}`).split('\0').filter(Boolean);
  const tests = changed.filter(path => /^test\/[^/]+\.test\.mjs$/.test(path));
  const source = changed.filter(path =>
    !/^(test|tests|docs|\.github)\//.test(path)
    && !/(^|\/)(?:[^/]*[.-])?config\.[^/]+$/.test(path)
    && (/\.(?:[cm]?js|jsx|tsx?|html|css|py|sh)$/.test(path)
      || git('ls-tree', head, '--', path).startsWith('100755 ')));
  report(`## Test-first footprint\n\nBase: \`${base}\`\nHead: \`${head}\`\nChanged test files: ${tests.length}\nChanged source files: ${source.length}`);
  if (!tests.length || !source.length) {
    report('Skipped: no changed test files or no non-test executable source change. Base and head tests not run.');
    process.exit(0);
  }
  const temporary = mkdtempSync(join(tmpdir(), 'test-first-'));
  const phases = [
    { label: 'Base', sha: base, directory: join(temporary, 'base') },
    { label: 'Head', sha: head, directory: join(temporary, 'head') },
  ];
  try {
    for (const phase of phases) git('worktree', 'add', '--detach', phase.directory, phase.sha);
    for (const path of tests) {
      const destination = join(phases[0].directory, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(phases[1].directory, path), destination);
    }
    for (const phase of phases) {
      const run = (command, args) => {
        const result = spawnSync(command, args, { cwd: phase.directory, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
        process.stdout.write(result.stdout ?? '');
        process.stderr.write(result.stderr ?? '');
        if (result.error || result.signal) throw result.error ?? Error(`Interrupted by ${result.signal}`);
        return result.status;
      };
      try {
        if (existsSync(join(phase.directory, 'package-lock.json')) && run('npm', ['ci']) !== 0) throw Error('npm ci failed');
        if (existsSync(join(phase.directory, 'package.json')) && run('npm', ['run', 'pretest', '--if-present']) !== 0) throw Error('pretest failed');
        phase.status = run(process.execPath, ['--test', '--test-concurrency=2', ...tests]) === 0 ? 'PASS' : 'FAIL';
      } catch (error) {
        phase.status = 'ERROR';
        console.error(`${phase.label} setup/runner error: ${error.message}`);
      }
      report(`${phase.label}: **${phase.status}** (${tests.length} test files)`);
    }
    if (phases[0].status === 'PASS') throw Error('these tests don’t test the change');
    if (phases[0].status !== 'FAIL' || phases[1].status !== 'PASS') throw Error('Expected failing tests on base and passing tests on head');
  } finally {
    for (const phase of phases) {
      if (existsSync(phase.directory)) git('worktree', 'remove', '--force', phase.directory);
    }
    rmSync(temporary, { recursive: true, force: true });
  }
} catch (error) {
  report(`Test-first footprint rejected: ${error.message}`);
  process.exitCode = 1;
}
