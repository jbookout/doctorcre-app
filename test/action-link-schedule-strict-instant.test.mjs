import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { uiBundle } from '../scripts/ui-bundle.mjs';
import { observeActionLink } from '../scripts/prove-action-link-schedule-strict-instant.mjs';
const bytes = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'), 'src/ui/action-link.tsx');
const { mountActionLink } = await import('data:text/javascript;base64,' + bytes.toString('base64'));
test('impossible schedule refuses approval through public mount', async () => {
  const dom = new JSDOM('<body><main></main></body>');
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const host = document.querySelector('main'), id = '11111111-1111-4111-8111-111111111111';
  const mounted = mountActionLink(host, { ref: 'al1_synthetic', request: async () => ({ kind: 'payload', payload: {
    schema_version: 'action-link-resolve.v1', ref: 'al1_synthetic', card: { kind: 'lead_draft', state: 'pending_approval', id, lead_id: id,
      revision: 1, subject: 'Synthetic', body: 'Synthetic', scheduled_for: '2026-02-31T10:00:00Z', time_zone: 'America/Chicago',
      actions: [{ action: 'approve', verb: 'approve-lead-draft', args: { draft_id: id, revision: 1 } }] },
  } }) });
  try {
    for (let n = 0; n < 100 && host.textContent.includes('Opening draft'); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(host.textContent, /could not be opened/);
    assert.equal(host.querySelector('time'), null);
    assert.equal(host.querySelector('button').textContent, 'Reload draft');
  } finally { mounted.dispose(); dom.window.close(); }
});
for (const zone of ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo']) {
  test(`strict schedule mount transitions in ${zone}`, async () => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    const dom = new JSDOM('<body></body>');
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    try { assert.ok((await observeActionLink('data:text/javascript;base64,' + bytes.toString('base64'))).length > 50); }
    finally { dom.window.close(); if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
}
