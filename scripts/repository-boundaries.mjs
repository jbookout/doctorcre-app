import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// A relative/absolute repository source path crosses ownership directly. A
// bare Node package is a different boundary; runtime cannot import CARR's
// internal packages, while development may consume separately pinned tooling.
const sourceImport = /(?:from\s+|import\s*\(\s*)["'](?:\.{1,2}\/|\/)(?:[^"']*\/)?(?:carr-system|mcp-server|control-room)(?:\/[^"']*)?["']/;
const internalPackage = /(?:from\s+|import\s*\(\s*)["'](?:[^"']*\/)?(?:carr-system|mcp-server|control-room)(?:\/[^"']*)?["']/;
export function hasCrossRepositoryImport(source, path) {
  return sourceImport.test(source) || !/^(?:test|tests|scripts|out|\.e2e)\//.test(path) && internalPackage.test(source);
}


export function repositoryFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).map(path => resolve(root, path));
}
