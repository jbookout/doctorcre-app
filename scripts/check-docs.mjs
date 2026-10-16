import { readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = new URL('../', import.meta.url);
const { scripts } = JSON.parse(await readFile(new URL('package.json', root)));
const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
for (const file of files) {
  let text;
  try { text = await readFile(new URL(file, root), 'utf8'); } catch { continue; }
  for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^(?:[a-z]+:|#|\/)/i.test(target)) continue;
    try { await access(resolve(root.pathname, dirname(file), decodeURIComponent(target.split('#')[0]))); }
    catch { console.warn(`${file}: missing local link ${target}`); }
  }
  for (const [, command] of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
    if (!Object.hasOwn(scripts, command)) console.warn(`${file}: unknown npm command ${command}`);
  }
}
