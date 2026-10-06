import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { Unzip, UnzipInflate } from 'fflate';

export function normalizeTokens(text, { decodeSource = true } = {}) {
  text = String(text);
  if (decodeSource) text = text
    // Consume literal backslash pairs before considering a source escape.
    .replace(/\\(\\|[uU][0-9a-fA-F]{4}|[nrtbfv])/g, (_, escape) => {
      if (escape === '\\') return '\\';
      return escape[0].toLowerCase() === 'u' ? String.fromCharCode(parseInt(escape.slice(1), 16)) : ' ';
    })
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, value) => {
      const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&(nbsp|Tab|NewLine|amp|quot|apos|lt|gt);/g, (_, entity) => ({
      nbsp: ' ', Tab: ' ', NewLine: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
    })[entity]);
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

export function validateCorpus(corpus) {
  if (corpus?.schema !== 'doctorcre-private-name-hashes.v1'
    || typeof corpus.salt !== 'string' || !/^[0-9a-f]{32,128}$/.test(corpus.salt)
    || !Number.isInteger(corpus.maxTokens) || corpus.maxTokens < 1 || corpus.maxTokens > 64
    || !Array.isArray(corpus.hashes) || !corpus.hashes.length
    || !corpus.hashes.every((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))) {
    throw new Error('invalid privacy corpus');
  }
  return corpus;
}

export function scanText(text, path, corpus, options) {
  validateCorpus(corpus);
  const hashes = new Set(corpus.hashes);
  const tokens = [];
  // Preserve original line attribution even when a name spans multiple lines.
  for (const [index, line] of text.split('\n').entries()) {
    for (const value of normalizeTokens(line, options)) tokens.push({ value, line: index + 1 });
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

// Decode evidence containers without extracting any files. Every member uses
// the same path/text checks as a source file, including nested Playwright traces.
async function* artifactInputs(bytes, path, budget, depth = 0) {
  if (depth > 4) throw new Error('archive nesting limit');
  const charge = size => {
    budget.remaining -= size;
    if (budget.remaining < 0) throw new Error('archive size limit');
  };
  if (/\.tar(?:\.gz)?$/.test(path)) {
    yield { path }; // Container names count too.
    const archive = path.endsWith('.gz')
      ? gunzipSync(bytes, { maxOutputLength: budget.remaining }) : bytes;
    charge(archive.length);
    const extract = tar.extract();
    extract.end(archive);
    for await (const entry of extract) {
      if (!['file', 'directory'].includes(entry.header.type)) throw new Error('unsupported archive entry');
      const chunks = [];
      for await (const chunk of entry) chunks.push(chunk);
      const member = `${path}!${entry.header.name}`;
      if (entry.header.type === 'directory') yield { path: member };
      else yield* artifactInputs(Buffer.concat(chunks), member, budget, depth + 1);
    }
  } else if (path.endsWith('.zip')) {
    yield { path };
    if (!bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
      && !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 5, 6]))) throw new Error('invalid ZIP');
    const members = [];
    const unzip = new Unzip(file => {
      const chunks = [];
      file.ondata = (error, chunk, final) => {
        if (error) throw error;
        charge(chunk.length);
        chunks.push(chunk);
        if (final) members.push({ path: `${path}!${file.name}`, bytes: Buffer.concat(chunks) });
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    unzip.push(bytes, true);
    for (const member of members) yield* artifactInputs(member.bytes, member.path, budget, depth + 1);
  } else {
    // Trace resources use content hashes rather than image extensions.
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = depth > 0 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      && bytes.subarray(-2).equals(Buffer.from([255, 217]));
    if (extname(path).toLowerCase() === '.png' && !png) throw new Error('invalid PNG');
    if (png || jpeg) { yield { path }; return; }
    if (bytes.includes(0)) throw new Error('unsupported text encoding');
    // Fatal decoding keeps unknown binaries and encodings from being skipped.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let json;
    try { json = JSON.parse(text); } catch { /* Most source files are not JSON. */ }
    if (json?.schema === 'doctorcre-private-name-hashes.v1') throw new Error('public privacy corpus');
    yield { path, text };
  }
}

async function main() {
  let root = fileURLToPath(new URL('../../', import.meta.url));
  let corpusPath = process.env.DOCTORCRE_PRIVACY_CORPUS_FILE || null;
  let base = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1]) throw new Error('missing argument');
    if (args[i] === '--root') root = resolve(args[i + 1]);
    else if (args[i] === '--corpus') corpusPath = resolve(args[i + 1]);
    else if (args[i] === '--base' && !args[i + 1].startsWith('-')) base = args[i + 1];
    else throw new Error('invalid argument');
  }
  // Private lookup material stays outside source control. CI supplies a secret;
  // local invocations use the operator's private configuration or --corpus.
  const corpus = validateCorpus(JSON.parse(corpusPath
    ? readFileSync(corpusPath, 'utf8')
    : process.env.DOCTORCRE_PRIVACY_CORPUS_JSON || readFileSync(resolve(homedir(), '.config/doctorcre-app/private-name-hashes.json'), 'utf8')));
  let failed = false;
  let index = 0;
  for (const path of changedFiles(root, base)) {
    const bytes = readFileSync(resolve(root, path));
    for await (const input of artifactInputs(bytes, path, { remaining: 256 * 1024 * 1024 })) {
      const pathFindings = scanText(input.path, input.path, corpus, { decodeSource: false });
      const locator = pathFindings.length ? `[redacted-path:${++index}]` : input.path.replace(/[\r\n\x00-\x1f]/g, '?');
      const lines = new Set([...pathFindings, ...scanText(input.text || '', input.path, corpus)].map(finding => finding.line));
      for (const line of lines) {
        process.stdout.write(`${locator}:${line}\n`);
        failed = true;
      }
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch { process.stdout.write('scripts/privacy/client-data-check.mjs:1\n'); process.exitCode = 2; }
}
