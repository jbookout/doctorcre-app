import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { launchProofBrowser, readAppRelease } from './app-release-reader.mjs';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export function contractFixture() {
  const boardContract = JSON.parse(readFileSync(new URL('../contracts/carr-interface.v1/mcp_read_contracts/deal-room-board.json', import.meta.url)));
  const networkContract = JSON.parse(readFileSync(new URL('../contracts/relationship-network.v1.json', import.meta.url)));
  const board = { schema_version: 'local-deals-board.v2', deals: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Fixture Deal', open_actions: [{ id: '33333333-3333-4333-8333-333333333333', item_id: 'next_action:33333333-3333-4333-8333-333333333333', owner: 'joe', description: 'Fixture Task', due_on: null }] }], closed_deals: [], lost_deals: [] };
  const network = { schema: 'carr-relationship-network.v1', observed_at: '2026-01-01T00:00:00Z', valid_until: '2026-01-01T00:02:00Z', nodes: [{ id: 'party:22222222-2222-4222-8222-222222222222', record_id: '22222222-2222-4222-8222-222222222222', name: 'Fixture Contact', kind: 'contact', contact_state: 'active' }], edges: [], referrals: [], suggestions: [] };
  assert.equal(board.schema_version, boardContract.response.schema_version);
  assert.equal(network.schema, networkContract.schema);
  for (const deal of board.deals) {
    assert.match(deal.id, /^[a-f0-9-]{36}$/);
    assert.equal(typeof deal.name, 'string');
    assert.ok(boardContract.response.deal_keys.includes('open_actions'));
    for (const action of deal.open_actions) {
      assert.deepEqual(Object.keys(action).sort(), [...boardContract.response.open_actions.item_keys].sort());
      assert.equal(typeof action.id, 'string');
      assert.equal(typeof action.description, 'string');
    }
  }
  for (const node of network.nodes) {
    assert.match(node.id, /^party:[a-f0-9-]{36}$/);
    assert.ok(networkContract.nodes.kinds.includes(node.kind));
    for (const field of Object.keys(node).filter(key => key !== 'id')) assert.ok(networkContract.nodes.fields.includes(field));
    assert.equal(typeof node.name, 'string');
  }
  return { board, network };
}

export async function observeKindFilter(page, payload) {
  await page.evaluate(async payload => {
    const { openQuickSwitcher } = await import('/js/ui-quick-switcher.generated.js');
    window.kindProofReads = 0;
    openQuickSwitcher({ opener: document.querySelector('button'), pages: [{ label: 'Fixture Page', href: '/calendar' }], read: async () => { window.kindProofReads++; return payload; } });
  }, payload);
  const input = page.getByRole('combobox', { name: 'Jump to', exact: true });
  const selector = page.getByRole('group', { name: 'Destination kind' });
  await page.getByRole('status').filter({ hasText: '1 destinations' }).waitFor();
  for (const kind of ['Deal', 'Contact', 'Task', 'Page']) {
    await selector.getByRole('button', { name: `${kind}s`, exact: true }).click();
    await page.getByRole('option').first().waitFor();
    assert.deepEqual(await page.getByRole('option').locator('small').allTextContents(), [kind]);
    await input.fill('  FIXTURE  ');
    assert.equal(await page.getByRole('option').count(), 1);
    await selector.getByRole('button', { name: 'All destinations', exact: true }).click();
    assert.equal(await input.inputValue(), '  FIXTURE  ');
    assert.equal(await page.getByRole('option').count(), 4);
    await input.fill('');
  }
  await input.fill('absent-fixture');
  await selector.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('No matches. Try a deal, contact or page name.').waitFor();
  assert.equal(await input.getAttribute('aria-activedescendant'), null);
  assert.equal(await page.evaluate(() => window.kindProofReads), 1);
  await input.fill('Fixture');
  await selector.getByRole('button', { name: 'All destinations', exact: true }).click();
  return { kinds: ['Deal', 'Contact', 'Task', 'Page'], business_reads: 1, matching_destinations: 4 };
}

export async function prove({ origin, timeout = 30000, engine = chromium }) {
  const controller = new AbortController();
  const unavailable = () => Object.assign(Error('Proof deadline exceeded'), { exitCode: 78 });
  const timer = setTimeout(() => controller.abort(unavailable()), timeout);
  let browser;
  const receipt = { status: 'insufficient_evidence', natural_acceptance: 'insufficient_evidence', deployed_module: 'unverified', release: null, release_after: null, requests: 0 };
  try {
    receipt.release = await readAppRelease(origin, { timeoutMs: timeout });
    browser = await launchProofBrowser(engine, { timeout, args: [...CHROMIUM_SAFETY_ARGS] }, { signal: controller.signal });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    context.setDefaultTimeout(timeout);
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (++receipt.requests > 64 || request.method() !== 'GET' || url.origin !== origin.origin) return route.abort();
      if (url.pathname === '/__kind-proof') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><button>Open</button>' });
      if (url.pathname.startsWith('/js/') && url.pathname.endsWith('.js')) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(new URL('/__kind-proof', origin).href);
    receipt.fixture_assertions = await observeKindFilter(page, contractFixture());
    receipt.release_after = await readAppRelease(origin, { timeoutMs: timeout });
    assert.equal(receipt.release.source_commit, receipt.release_after.source_commit);
    receipt.deployed_module = 'pass';
    return { code: 78, receipt };
  } catch (error) {
    return { code: error.exitCode || (controller.signal.aborted ? 78 : 1), receipt: { ...receipt, status: error.exitCode === 78 || controller.signal.aborted ? 'insufficient_evidence' : 'failed', error: error.message } };
  } finally { clearTimeout(timer); await browser?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { origin: { type: 'string' }, 'timeout-ms': { type: 'string', default: '30000' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: node scripts/prove-quick-switcher-kind-filter.mjs --origin https://app.doctorcre.com --timeout-ms 30000. GET only, 64 requests maximum. JSON receipt. Exit 1 assertion failure, 78 insufficient natural session evidence, including when deployed fixture assertions pass.');
    else {
      const origin = new URL(values.origin);
      const timeout = Number(values['timeout-ms']);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw Error('Invalid origin or timeout');
      const result = await prove({ origin, timeout });
      console.log(JSON.stringify(result.receipt));
      process.exitCode = result.code;
    }
  } catch (error) { console.log(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = 1; }
}
