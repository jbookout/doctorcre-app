import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public salt prevents reuse of unsalted lookup tables; it is not encryption.
// Corpus generation is local, through the authenticated read-only record API.
export function normalizeTokens(text) {
  return String(text).replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

export function validateCorpus(corpus) {
  if (corpus?.schema !== 'doctorcre-private-name-hashes.v1'
    || !/^[0-9a-f]{32,128}$/.test(corpus.salt || '')
    || !Number.isInteger(corpus.maxTokens) || corpus.maxTokens < 1 || corpus.maxTokens > 64
    || !Array.isArray(corpus.hashes) || !corpus.hashes.length
    || !corpus.hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))) {
    throw new Error('invalid privacy corpus');
  }
  return corpus;
}

export function scanText(text, path, corpus) {
  validateCorpus(corpus);
  const hashes = new Set(corpus.hashes);
  const tokens = [];
  // Preserve original line attribution even when a name spans multiple lines.
  for (const [index, line] of text.split('\n').entries()) {
    for (const value of normalizeTokens(line)) tokens.push({ value, line: index + 1 });
  }
  const findings = new Set();
  for (let start = 0; start < tokens.length; start++) {
    let phrase = '';
    for (let end = start; end < Math.min(tokens.length, start + corpus.maxTokens); end++) {
      phrase += tokens[end].value;
      const hash = createHash('sha256').update(`${corpus.salt}\0${phrase}`).digest('hex');
      if (hashes.has(hash)) findings.add(tokens[start].line);
    }
  }
  return [...findings].sort((a, b) => a - b).map((line) => ({ path, line }));
}

export function changedFiles(root, base) {
  const args = base
    ? ['diff', '--name-only', '--diff-filter=ACMRT', '-z', base, '--']
    : ['ls-files', '-z'];
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString('utf8').split('\0').filter(Boolean);
}

function main() {
  let root = fileURLToPath(new URL('../../', import.meta.url));
  let corpusPath = fileURLToPath(new URL('./private-name-hashes.json', import.meta.url));
  let base = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1]) throw new Error('missing argument');
    if (args[i] === '--root') root = resolve(args[i + 1]);
    else if (args[i] === '--corpus') corpusPath = resolve(args[i + 1]);
    else if (args[i] === '--base' && !args[i + 1].startsWith('-')) base = args[i + 1];
    else throw new Error('invalid argument');
  }
  const corpus = validateCorpus(JSON.parse(readFileSync(corpusPath, 'utf8')));
  let failed = false;
  for (const path of changedFiles(root, base)) {
    const bytes = readFileSync(resolve(root, path));
    if (bytes.includes(0)) continue;
    for (const finding of scanText(bytes.toString('utf8'), path, corpus)) {
      // Escape control characters in paths, too. Never print names or excerpts.
      process.stdout.write(`${finding.path.replace(/[\r\n\x00-\x1f]/g, '?')}:${finding.line}\n`);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { process.stdout.write('scripts/privacy/client-data-check.mjs:1\n'); process.exitCode = 2; }
}
