import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { normalizeTokens, scanText, validateCorpus, changedFiles } from '../scripts/privacy/client-data-check.mjs';

const salt = '1234567890abcdef1234567890abcdef';
const digest = (text) => createHash('sha256').update(`${salt}\0${normalizeTokens(text).join('')}`).digest('hex');
const corpus = { schema: 'doctorcre-private-name-hashes.v1', salt, maxTokens: 4,
  hashes: [digest('Planted Fictional Dental'), digest('Imaginary Practitioner'), digest('C-987654')] };

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
