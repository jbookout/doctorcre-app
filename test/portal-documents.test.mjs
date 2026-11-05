import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/ui/portal/documents.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs' });
const module = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, () => { throw Error('Unexpected dependency'); });
const { parseDocuments } = module.exports;
const fixture = JSON.parse(readFileSync('test/fixtures/portal-documents/authorized.json'));
test('authorized text projection discards internal fields and file authority', () => {
  const input = structuredClone(fixture);
  input.portal.internal_note = 'Internal';
  input.portal.materials[0].download_url = 'https://example.test/private';
  assert.deepEqual(parseDocuments(input, 'example-health'), { kind: 'ready', materials: fixture.portal.materials });
});
test('empty, malformed, cross-portal, unsupported and private material responses refuse safely', () => {
  assert.deepEqual(parseDocuments({ ...fixture, portal: { ...fixture.portal, materials: [] } }, 'example-health'), { kind: 'empty' });
  for (const input of [null, {}, { ...fixture, ok: false }, { ...fixture, schema_version: 'client-portal.v2' },
    { ...fixture, portal: { ...fixture.portal, slug: 'second-portal' } },
    ...[null, [{ kind: 'note', title: 'Internal', content: 'Secret' }], [{ kind: 'document', title: 'Missing text' }],
      Array(101).fill(fixture.portal.materials[0]),
      [{ ...fixture.portal.materials[0], title: 'a'.repeat(201) }],
      [{ ...fixture.portal.materials[0], content: 'a'.repeat(10001) }],
      [{ ...fixture.portal.materials[0], content: ' ' }]].map(materials => ({ ...fixture, portal: { ...fixture.portal, materials } }))]) {
    assert.deepEqual(parseDocuments(input, 'example-health'), { kind: 'refused' });
  }
});
test('maximum contract list is supported', () => {
  const material = { kind: 'document', title: 'a'.repeat(200), content: 'a'.repeat(10000) };
  assert.equal(parseDocuments({ ...fixture, portal: { ...fixture.portal, materials: Array(100).fill(material) } }, 'example-health').materials.length, 100);
});

for (const [field, limit] of [['title', 200], ['content', 10000]]) {
  test(`space-padded ${field} at the producer limit preserves every authorized material`, () => {
    const input = structuredClone(fixture);
    input.portal.materials[0][field] = ` ${'🩺'.repeat(limit)} `;
    assert.deepEqual(parseDocuments(input, 'example-health'), { kind: 'ready', materials: input.portal.materials });
  });
}
test('non-space whitespace counts toward the producer limit and malformed lists refuse as a whole', () => {
  const input = structuredClone(fixture);
  input.portal.materials[0].title = '\t';
  assert.deepEqual(parseDocuments(input, 'example-health'), { kind: 'ready', materials: input.portal.materials });
  for (const title of [' '.repeat(202), ` ${'a'.repeat(201)} `, `\t${'a'.repeat(200)}\t`]) {
    input.portal.materials[0].title = title;
    assert.deepEqual(parseDocuments(input, 'example-health'), { kind: 'refused' });
  }
});
