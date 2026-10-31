import { execFileSync } from 'node:child_process';

// These directories contain the app's first-party browser surfaces.
const surfacePath = /^(?:js|src\/ui|tours|reports|public-shell)\/(?!.*(?:^|\/)vendor\/).*\.(?:js|jsx)$/;
try {
  const base = process.argv[2];
  if (!base) throw new Error('A base commit is required');
  const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const added = execFileSync('git', ['diff', '--no-renames', '--diff-filter=A', '--name-only', '-z', mergeBase, 'HEAD', '--'], { encoding: 'utf8' }).split('\0');
  const violations = added.filter(path => surfacePath.test(path));
  if (violations.length) throw new Error(`New UI surfaces must be React and TypeScript (.tsx):\n${violations.join('\n')}`);
  console.log('Typed surface check passed');
} catch (error) {
  console.error(`Typed surface check failed: ${error.message}`);
  process.exitCode = 1;
}
