import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile, cp, symlink } from 'node:fs/promises';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkedCarrFixture, validateCarrFixture } from './support/carr-fixture-contract.mjs';
import { checkCarrFixtures, responseLiterals, literalInventoryDigest } from '../scripts/check-carr-fixtures.mjs';

const terms = new URL('./fixtures/carr/market-terms-three-rows.json', import.meta.url);

test('replay refuses 739 impossible deal count, while corrected producer response passes', async () => {
  const record = JSON.parse(await readFile(terms, 'utf8'));
  record.response.coverage.comparable_deals = 99;
  assert.throws(() => validateCarrFixture(record), /producer response mismatch/);
  record.response.coverage.comparable_deals = 2;
  assert.deepEqual(validateCarrFixture(record), checkedCarrFixture('market-terms-three-rows'));
});

test('the check refuses an unregistered handwritten response, even with a helper import', async () => {
  const root = temporaryDirectory('carr-fixture-gate-');
  try {
    await mkdir(join(root, 'test'), {recursive:true});
    await writeFile(join(root, 'test/example.test.mjs'), `import { checkedCarrFixture } from './helper.mjs';\nconst response = {ok:true, coverage:{comparable_deals:99}};`);
    assert.ok((await checkCarrFixtures(root, {})).some(error => /example.test.mjs/.test(error)));
    await writeFile(join(root, 'test/example.test.mjs'), `const response = checkedCarrFixture('market-terms-empty');`);
    assert.deepEqual(await checkCarrFixtures(root, {}), []);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('unregistered JSON responses and changed legacy literals fail closed', async () => {
  const root = temporaryDirectory('carr-fixture-gate-');
  try {
    await mkdir(join(root, 'test/fixtures'), {recursive:true});
    const path = 'test/fixtures/old.json';
    const source = '{"filings":[{"occurred_at":42}]}';
    await writeFile(join(root,path),source);
    const [literal] = responseLiterals(path,source);
    const legacy = {[path]:literalInventoryDigest([literal])};
    assert.deepEqual(await checkCarrFixtures(root,legacy),[]);
    await writeFile(join(root,path),source.replace('42','99'));
    assert.equal((await checkCarrFixtures(root,legacy)).length,1);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('unknown producer, mismatched source pin and invalid calendar recording refuse', async () => {
  const record = JSON.parse(await readFile(terms,'utf8'));
  assert.throws(() => validateCarrFixture({...record, producer:'unknown'}), /unknown producer/);
  assert.throws(() => validateCarrFixture({...record, source_sha256:'0'.repeat(64)}), /source pin/);
  const calendar = JSON.parse(await readFile(new URL('./fixtures/carr/calendar-empty.json',import.meta.url),'utf8'));
  calendar.response.items.push({title:'impossible',start:'2026-11-05'});
  assert.throws(() => validateCarrFixture(calendar), /producer response mismatch/);
});

test('repository check replays registered JSON instead of accepting registration alone', async () => {
  const root = temporaryDirectory('carr-fixture-replay-');
  try {
    await mkdir(join(root,'test/fixtures/carr'), {recursive:true});
    const record = JSON.parse(await readFile(terms,'utf8'));
    record.response.coverage.comparable_deals = 99;
    const path = join(root,'test/fixtures/carr/terms.json');
    await writeFile(path,JSON.stringify(record));
    assert.match((await checkCarrFixtures(root,{})).join('\n'),/producer response mismatch/);
    record.response.coverage.comparable_deals = 2;
    await writeFile(path,JSON.stringify(record));
    assert.deepEqual(await checkCarrFixtures(root,{}),[]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('every committed registered recording is replayed by the repository check', async () => {
  const root = new URL('../',import.meta.url);
  const legacy = JSON.parse(await readFile(new URL('test/fixtures/carr-legacy-literals.json',root),'utf8'));
  assert.deepEqual(await checkCarrFixtures(root,legacy),[]);
});


test('certified responses refuse the positive 99-deal mutation before the real parser consumes it', () => {
  const response = checkedCarrFixture('market-terms-three-rows');
  assert.throws(() => { response.coverage.comparable_deals = 99; }, TypeError);
  assert.throws(() => { response.rows.push(response.rows[0]); }, TypeError);
  assert.equal(response.coverage.comparable_deals, 2);
});

test('existing calendar and market replay formats are verified without an unchecked exception', async () => {
  const root = temporaryDirectory('carr-existing-replay-');
  try {
    await mkdir(join(root, 'test'), {recursive:true});
    for (const [file,producer] of [['calendar-empty','calendar-section'],['market-terms-three-rows','read-market-terms']]) {
      const record = JSON.parse(await readFile(new URL(`./fixtures/carr/${file}.json`,import.meta.url),'utf8'));
      const provenance = {repository:'DoctorCRE/carr-system',path:producer === 'calendar-section' ? 'mcp-server/src/brief-calendar.js' : 'mcp-server/src/market-terms.ts',source_sha256:record.source_sha256};
      const group = {provenance,records:[{...record.input,response:record.response}]};
      const path = join(root,'test/recording.mjs');
      await writeFile(path,`export const recording = ${JSON.stringify(group)};`);
      assert.deepEqual(await checkCarrFixtures(root,{}),[]);
      group.records[0].response = JSON.parse('{"ok":true}');
      await writeFile(path,`export const recording = ${JSON.stringify(group)};`);
      assert.match((await checkCarrFixtures(root,{})).join('\n'),/producer response mismatch/);
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});


test('static producer artifacts are verified against pinned source before discovery or replay', async t => {
  const root = temporaryDirectory('carr-static-producer-', t);
  await mkdir(join(root, 'test/support'), {recursive:true});
  await mkdir(join(root, 'test/fixtures'), {recursive:true});
  await cp(new URL('./fixtures/carr-producers/', import.meta.url), join(root, 'test/fixtures/carr-producers'), {recursive:true});
  await cp(new URL('./support/carr-fixture-contract.mjs', import.meta.url), join(root, 'test/support/carr-fixture-contract.mjs'));
  await symlink(new URL('../node_modules/', import.meta.url).pathname, join(root, 'node_modules'), 'dir');
  const helper = await import(pathToFileURL(join(root, 'test/support/carr-fixture-contract.mjs')));
  assert.equal(helper.validateCarrProducerModules().length, 2);
  const record = JSON.parse(await readFile(terms, 'utf8'));
  for (const file of ['brief-calendar.mjs', 'market-terms.mjs']) {
    const path = join(root, 'test/fixtures/carr-producers', file);
    const original = await readFile(path, 'utf8');
    await writeFile(path, original + '\nexport const unchecked = true;\n');
    assert.throws(() => helper.validateCarrProducerModules(), /static producer module differs/);
    assert.match((await checkCarrFixtures(root, {})).join('\n'), /static producer module differs/);
    if (file === 'market-terms.mjs') assert.throws(() => helper.validateCarrFixture(record), /static producer module differs/);
    await writeFile(path, original);
  }
  assert.deepEqual(helper.validateCarrFixture(record), checkedCarrFixture('market-terms-three-rows'));
});
