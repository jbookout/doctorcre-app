import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { changedFiles, scanText } from '../scripts/privacy/client-data-check.mjs';
const corpus = JSON.parse(readFileSync(new URL('../scripts/privacy/private-name-hashes.json', import.meta.url)));
test('public tracked text contains no verified private names', () => {
 const findings = changedFiles(process.cwd()).filter(path => existsSync(path)).flatMap(path => {
  const bytes = readFileSync(path);
  return bytes.includes(0) ? [] : scanText(bytes.toString('utf8'), path, corpus);
 });
 assert.deepEqual(findings, [], 'privacy findings contain file/line only');
});
