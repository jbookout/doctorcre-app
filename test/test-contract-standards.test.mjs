import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTestContracts, testContractFindings } from '../scripts/check-test-contracts.mjs';

const loadContracts = `const contract = JSON.parse(await read('contracts/carr-interface.v1.json')); const routes = JSON.parse(await read('contracts/app-routes.v1.json'));\n`;

test('contract pin guard rejects literal versions and revisions, including aliases and expected objects', () => {
  for (const source of [
    `assert.equal(contract.version, '1.43.0');`,
    `assert.strictEqual(routes['version'], "1.20.0");`,
    `const pin = 'abcdef0123456789abcdef0123456789abcdef01'; assert.equal(contract.producer.source_commit, pin);`,
    `assert.deepEqual(contract.producer, {source_commit: 'abcdef0123456789abcdef0123456789abcdef01'});`,
    `assert.deepEqual(release, {carr_contract: {version: '1.43.0'}});`,
    `assert.equal('1.43.0', contract.version);`,
    `import {strictEqual as eq} from 'node:assert/strict'; eq(contract.version, '1.43.0');`,
    `import * as checks from 'node:assert'; checks['deepStrictEqual'](release, {route_contract: {version: '1.20.0'}});`,
    `import runtime from '../contracts/carr-interface.v1.json' with {type: 'json'}; assert.equal(runtime.version, '1.43.0');`,
  ]) assert.equal(testContractFindings(loadContracts + source).length, 1, source);
});

test('contract pin guard permits feature assertions, format validation and contract-derived expectations', () => {
  for (const source of [
    `assert.equal(release.carr_contract.version, contract.version);`,
    `assert.match(contract.producer.source_commit, /^[a-f0-9]{40}$/);`,
    `assert.ok(contract.mcp_operations.includes('read-room'));`,
    `assert.equal(row.version, 3);`,
    `assert.equal(contract.schema, 'doctorcre-carr-interface.v1');`,
    `assert.equal(message, '1.43.0');`,
    `// assert.equal(contract.version, '1.43.0');\nconst example = "assert.equal(contract.version, '1.43.0')";`,
    `assert.deepEqual(release, {carr_contract: {version: contract.version}});`,
    `assert.equal(fixture.version, '1.43.0');`,
    `assert.deepEqual(syntheticManifest, {source_commit: 'abcdef0123456789abcdef0123456789abcdef01'});`,
  ]) assert.deepEqual(testContractFindings(loadContracts + source), [], source);
});

test('contract pin guard reports the assertion location and fails on invalid syntax', () => {
  assert.equal(testContractFindings(loadContracts + `\n\nassert.equal(contract.version, '1.43.0');`)[0].line, 4);
  assert.throws(() => testContractFindings('assert.equal('), SyntaxError);
});

test('repository guard checks nested Node test helpers and rejects a reintroduced pin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-contract-guard-'));
  const directory = join(root, 'test', 'helpers');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'contract.mjs');
  await writeFile(path, loadContracts + `assert.equal(contract.version, '1.43.0');`);
  await assert.rejects(checkTestContracts(root), /test\/helpers\/contract\.mjs:2: derive contract expectations/);
  await writeFile(path, loadContracts + `assert.ok(contract.mcp_operations.includes('read-room'));`);
  await checkTestContracts(root);
});
