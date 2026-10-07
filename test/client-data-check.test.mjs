import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { normalizeTokens, scanText, validateCorpus, changedFiles } from '../scripts/privacy/client-data-check.mjs';

const salt = '1234567890abcdef1234567890abcdef';
const digest = (text) => createHash('sha256').update(`${salt}\0${normalizeTokens(text).join('')}`).digest('hex');
const corpus = { schema: 'doctorcre-private-name-hashes.v1', salt, maxTokens: 4,
  hashes: [digest('Planted Fictional Dental'), digest('Imaginary Practitioner'), digest('C-987654')] };

function cliFixture(t, files, input = corpus, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'privacy-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '--', ...Object.keys(files)], { cwd: root });
  const corpusPath = join(root, 'corpus.json');
  writeFileSync(corpusPath, JSON.stringify(input));
  return spawnSync(process.execPath, [new URL('../scripts/privacy/client-data-check.mjs', import.meta.url).pathname,
    '--root', root, ...(options.defaultCorpus ? [] : ['--corpus', corpusPath])], {
    encoding: 'utf8', env: { ...process.env, HOME: root, DOCTORCRE_PRIVACY_CORPUS_JSON: '', DOCTORCRE_PRIVACY_CORPUS_FILE: '', ...options.env },
  });
}

test('public artifacts contain no private lookup corpus', () => {
  const path = new URL('../scripts/privacy/private-name-hashes.json', import.meta.url);
  assert.equal(existsSync(path), false, 'private record-derived lookup material must be supplied outside the public repository');
});

test('CLI fails closed without private configuration even when a repository corpus exists', t => {
  const result = cliFixture(t, { 'safe.txt': 'clean' }, corpus, { defaultCorpus: true });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, 'scripts/privacy/client-data-check.mjs:1\n');
});

for (const [label, bytes] of [
  ['NUL in HTML', Buffer.from('<p>Planted Fictional Dental</p>\0')],
  ['UTF-16 text', Buffer.from('Planted Fictional Dental', 'utf16le')],
  ['invalid UTF-8', Buffer.concat([Buffer.from('Planted Fictional Dental'), Buffer.from([0xff])])],
]) test(`CLI rejects unsupported text bytes: ${label}`, t => {
  const result = cliFixture(t, { 'example.html': bytes });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, 'scripts/privacy/client-data-check.mjs:1\n');
  assert.equal(result.stderr, '');
});

for (const source of [
  '"Planted\\nFictional Dental"', '"Planted\\tFictional Dental"',
  '<p>Planted&#32;Fictional Dental</p>', '<p>Planted&#x20;Fictional Dental</p>',
  '<p>Planted&nbsp;Fictional Dental</p>',
]) test(`CLI catches encoded whitespace: ${JSON.stringify(source)}`, t => {
  const result = cliFixture(t, { 'example.txt': source });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'example.txt:1\n');
});

const backslashCorpus = {
  schema: 'doctorcre-private-name-hashes.v1', salt, maxTokens: 2,
  hashes: [createHash('sha256').update(`${salt}\0syntheticfictional`).digest('hex')],
};

for (const count of [1, 2, 3]) {
  test(`CLI preserves name letters after ${count} escaped literal backslashes`, t => {
    const source = JSON.stringify({ name: `Synthetic ${'\\'.repeat(count)}fictional` });
    const result = cliFixture(t, { 'example.json': source }, backslashCorpus);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'example.json:1\n');
    assert.equal(result.stderr, '');
  });
}

test('CLI preserves uppercase letters after an unrecognized source escape', t => {
  const result = cliFixture(t, { 'example.txt': 'Synthetic \\Fictional' }, backslashCorpus);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'example.txt:1\n');
});

for (const contents of ['clean', 'Synthetic fictional']) {
  test(`CLI scans raw backslashes in identifying paths with ${contents === 'clean' ? 'clean' : 'identifying'} contents`, t => {
    const result = cliFixture(t, { 'Synthetic \\fictional.txt': contents }, backslashCorpus);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^\[redacted-path:\d+\]:1\n$/);
    assert.doesNotMatch(result.stdout + result.stderr, /Synthetic|fictional/);
  });
}

for (const contents of ['clean', 'Planted Fictional Dental']) {
  test(`CLI detects identifying filenames and redacts their diagnostics with ${contents === 'clean' ? 'clean' : 'identifying'} contents`, t => {
    const result = cliFixture(t, { 'Planted Fictional Dental.txt': contents });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^\[redacted-path:\d+\]:1\n$/);
    assert.doesNotMatch(result.stdout + result.stderr, /Planted|Fictional|Dental/);
  });
}

test('CLI checks names split across path components, including binary assets', t => {
  const png = readFileSync(new URL('../public-shell/icons/dealroom-192.png', import.meta.url));
  const result = cliFixture(t, { 'Planted/Fictional/Dental.png': png });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^\[redacted-path:\d+\]:1\n$/);
});

test('CLI accepts supported binary assets without disabling text validation', t => {
  const png = readFileSync(new URL('../public-shell/icons/dealroom-192.png', import.meta.url));
  assert.equal(cliFixture(t, { 'safe.png': png, 'safe.txt': 'clean' }).status, 0);
  assert.equal(cliFixture(t, { 'fake.png': Buffer.from('Planted Fictional Dental\0') }).status, 2);
});

for (const [field, value] of [
  ['hashes', [[corpus.hashes[0]]]], ['hashes', [null]], ['hashes', [42]],
  ['salt', [salt]], ['maxTokens', '4'], ['hashes', { 0: corpus.hashes[0] }],
]) test(`CLI rejects malformed JSON types: ${field} ${JSON.stringify(value).slice(0, 20)}`, t => {
  const result = cliFixture(t, { 'example.txt': 'Planted Fictional Dental' }, { ...corpus, [field]: value });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, 'scripts/privacy/client-data-check.mjs:1\n');
});

test('CLI loads the private corpus from environment configuration', t => {
  const result = cliFixture(t, { 'example.txt': 'Planted Fictional Dental' }, corpus, {
    defaultCorpus: true, env: { DOCTORCRE_PRIVACY_CORPUS_JSON: JSON.stringify(corpus) },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'example.txt:1\n');
});

test('CLI rejects a tracked private corpus as a public disclosure', t => {
  const result = cliFixture(t, { 'corpus.json': JSON.stringify(corpus), 'safe.txt': 'clean' });
  assert.equal(result.status, 2);
});

test('synthetic planted names, tokens and refs are caught with only file:line findings', () => {
  const source = 'clean\n"PLANTED fictional-Dental"\nImaginary Practitioner\nC-987654';
  assert.deepEqual(scanText(source, 'example.txt', corpus), [
    { path: 'example.txt', line: 2 }, { path: 'example.txt', line: 3 }, { path: 'example.txt', line: 4 },
  ]);
  assert.deepEqual(scanText('Example Dental Group\nC-000\nImaginary unrelated', 'clean.txt', corpus), []);
});

test('normalization catches accents, punctuation, escaped JSON, identifiers and line breaks', () => {
  for (const source of ['Plánted Fictional Dental', 'Planted_Fictional_Dental', 'Planted\nFictional Dental', 'Planted \\u0046ictional Dental']) {
    assert.equal(scanText(source, 'sample.json', corpus)[0]?.line, 1);
  }
});

test('invalid and empty corpora fail closed', () => {
  for (const bad of [{}, { ...corpus, hashes: [] }, { ...corpus, salt: '' }, { ...corpus, hashes: ['bad'] }, { ...corpus, maxTokens: 0 }]) {
    assert.throws(() => validateCorpus(bad));
  }
  assert.doesNotThrow(() => validateCorpus(corpus));
});

test('CLI scans changed whole files, omits deleted files, and never prints matched content', () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-check-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Synthetic Test');
    writeFileSync(join(root, 'old.txt'), 'clean'); git('add', 'old.txt'); git('commit', '-qm', 'synthetic baseline');
    const base = git('rev-parse', 'HEAD').toString().trim();
    rmSync(join(root, 'old.txt')); writeFileSync(join(root, 'new.txt'), 'clean\nPlanted Fictional Dental');
    git('add', 'old.txt', 'new.txt'); git('commit', '-qm', 'synthetic change');
    assert.deepEqual(changedFiles(root, base), ['new.txt']);
    writeFileSync(join(root, 'corpus.json'), JSON.stringify(corpus));
    const result = spawnSync(process.execPath, [new URL('../scripts/privacy/client-data-check.mjs', import.meta.url).pathname,
      '--root', root, '--corpus', join(root, 'corpus.json'), '--base', base], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, 'new.txt:2\n');
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /Planted|Fictional|Dental|987654/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
