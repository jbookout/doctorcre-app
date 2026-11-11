import test from 'node:test';
import assert from 'node:assert/strict';
import { componentDocument, chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { observe } from '../scripts/prove-email-source-disclosure-retention.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedResponses, producerIdentity, recordings } from './fixtures/email-source-disclosure.mjs';

test('every successful recording equals the pinned registered producer', async () => {
  assert.equal(producerIdentity.revision, 'f08895ac514770f8ce6eb00a29159a6072da9c46');
  assert.equal(producerIdentity.files['email-proposals.js'], 'c7d88f4776f4b41350a010bbb853efe388efc4f933630874461629a9e5972752');
  const expected = await checkedResponses();
  assert.equal(Object.keys(expected).length, 8);
  const observed = await observe({ evaluate: async (_observation, payload) => payload });
  assert.deepEqual(observed.responses, expected, 'proof passes exactly the producer-checked recordings to the app');
  assert.equal(observed.producerHash, producerIdentity.files['email-proposals.js']);
  for (const name of Object.keys(recordings())) {
    const record = recordings()[name];
    if (record.verb === 'preview-email-next-step') delete record.response.proposal_digest;
    else if (record.response.proposals.length) delete record.response.proposals[0].status;
    else record.response.proposals.push({ id: 'invalid parser input' });
    await assert.rejects(checkedResponses({ [name]: record }), /equals pinned producer/);
  }
});

test('source disclosure lifecycle at phone and desktop widths in both themes', async t => {
  const outDir = temporaryDirectory('source-disclosure-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: process.cwd(), outDir });
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) await t.test(`${width} ${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
    try {
      await componentDocument(page, server.origin, {owner:'email source disclosure', html:'<script type="module" src="/js/doc-context.js"></script>'});
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const receipt = await observe(page);
      assert.equal(receipt.checks.length, 21);
      assert.equal(receipt.fixture_contract, 'email-proposals.v1');
      assert.equal(receipt.fixture_producer, producerIdentity.files['email-proposals.js']);
    } finally { await page.close(); }
  });
});
