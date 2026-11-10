import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { factFixture } from '../scripts/prove-home-fact-review-refresh-selection.mjs';
const bundle = await build({ entryPoints: ['src/ui/home/inbox.tsx', 'src/ui/home/review.ts'], bundle: true, write: false, outdir: 'out', platform: 'node', format: 'esm' });
const modules = await Promise.all(bundle.outputFiles.map(file => import(`data:text/javascript;base64,${Buffer.from(file.text).toString('base64')}`)));
const { parseItem } = modules.find(module => module.parseItem);
const { parseReview } = modules.find(module => module.parseReview);
const contract = JSON.parse(await readFile('contracts/carr-interface.v1/home_review.json'));
test('every synthetic refresh fixture crosses the production reference and review parsers', () => {
  for (const mode of ['retained', 'removed', 'replaced', 'empty', 'forbidden', 'no-choice', 'schedule', 'correct-empty', 'reload-failure']) for (const fresh of [false, true]) {
    const { row, review } = factFixture(mode, fresh);
    const item = parseItem(row, true);
    const parsed = parseReview(review, item.review_reference);
    assert.equal(parsed.kind, 'fact_review');
    assert.equal(review.schema_version, contract.schema_version);
    assert.deepEqual(review.reference.operations, contract.kinds.fact_review);
    assert.deepEqual(parsed.observations.map(o => o.id), review.detail.observations.map(o => o.id));
  }
});
