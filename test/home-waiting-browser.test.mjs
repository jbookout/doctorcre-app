import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
let outDir;
const fixture = await build({ entryPoints: ['src/ui/home/fixture.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { fixtureInboxRpc } = await import(`data:text/javascript;base64,${Buffer.from(fixture.outputFiles[0].contents).toString('base64')}`);
before(async () => { outDir = temporaryDirectory('home-waiting-'); await buildArtifact({ root: process.cwd(), outDir }); await mkdir('/tmp/WR617.S15.J9-evidence', { recursive: true }); });
after(async () => { await rm(outDir, { recursive: true, force: true }); });
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`waiting person set correct clear and complete ${width} ${theme}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  const rpc = fixtureInboxRpc(); const writes = []; let conflict = false; let lost = false;
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    let value;
    if (['set-home-waiting', 'clear-home-waiting'].includes(name)) {
      writes.push({ name, args });
      if (conflict) { conflict = false; value = { error: 'version_conflict' }; }
      else { value = await rpc(name, args); if (lost) { lost = false; return route.abort(); } }
    } else if (['read-home-inbox-v5', 'email-match-contacts', 'complete-one-action'].includes(name)) value = await rpc(name, args);
    else if (['read-actor-roster-v1', 'search-parties-v1'].includes(name)) value = { error: 'unknown_tool' };
    else value = name === 'calendar-meeting-prep' ? { state: 'empty', items: [] } : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    return route.fulfill({ json: { result: { ...(value.error ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  const row = page.locator('[data-inbox-row="demo-review"]');
  await row.getByText('Waiting on someone · Not recorded', { exact: true }).waitFor();
  for (const id of ['demo-working', 'demo-snooze', 'demo-complete']) assert.equal(await page.locator(`[data-inbox-row="${id}"]`).getByText(/Waiting on/).count(), 0);
  await row.getByRole('button', { name: 'Set waiting person', exact: true }).click();
  await row.getByRole('button', { name: 'Load people', exact: true }).click();
  await row.getByText('Name search is unavailable on this server. Showing existing contact choices.', { exact: true }).waitFor();
  await row.getByLabel('Person', { exact: true }).selectOption('00000000-0000-0000-0000-000000000099');
  await row.getByLabel('Reason', { exact: true }).fill('Review the lease terms');
  await row.getByLabel('Evidence references, one per line').fill('call:synthetic');
  await page.screenshot({ path: `/tmp/WR617.S15.J9-evidence/editor-${width}-${theme}.png`, fullPage: true });
  conflict = true;
  await row.getByRole('button', { name: 'Save waiting person', exact: true }).click();
  await row.getByText(/This card changed. Your edit is kept/).waitFor();
  assert.equal(await row.getByLabel('Reason', { exact: true }).inputValue(), 'Review the lease terms');
  await row.getByRole('button', { name: 'Refresh this card', exact: true }).click();
  await row.getByText(/Latest card loaded/).waitFor();
  lost = true;
  await row.getByRole('button', { name: 'Save waiting person', exact: true }).click();
  await row.getByRole('button', { name: 'Retry same waiting request', exact: true }).waitFor();
  await row.getByRole('button', { name: 'Retry same waiting request', exact: true }).click();
  await row.getByText('Waiting on Demo reviewer', { exact: true }).waitFor();
  assert.deepEqual(writes[1], writes[2]);
  assert.equal(writes[1].args.base_version, 0); assert.equal(writes[1].args.item_version, 'synthetic:1');
  assert.equal(writes.length, 3); assert.equal(writes[1].args.item_id, 'demo-review'); assert.equal('items' in writes[1].args, false);
  await page.reload();
  await row.getByText('Waiting on Demo reviewer', { exact: true }).waitFor();
  await row.getByText('Review the lease terms', { exact: true }).waitFor();
  await page.screenshot({ path: `/tmp/WR617.S15.J9-evidence/recorded-${width}-${theme}.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await row.getByRole('button', { name: 'Correct waiting person', exact: true }).click();
  await row.getByRole('button', { name: 'Load people', exact: true }).click();
  await row.getByLabel('Person', { exact: true }).selectOption('00000000-0000-0000-0000-000000000098');
  await row.getByLabel('Reason', { exact: true }).fill('Coordinator has the next move');
  await row.getByRole('button', { name: 'Save waiting person', exact: true }).click();
  await row.getByText('Waiting on Demo coordinator', { exact: true }).waitFor();
  assert.equal(writes[3].args.target.id, '00000000-0000-0000-0000-000000000098');
  await row.getByRole('button', { name: 'Correct waiting person', exact: true }).click();
  await row.getByLabel('Reason', { exact: true }).fill('Response received');
  await row.getByRole('button', { name: 'Clear waiting person', exact: true }).click();
  await row.getByText('Waiting on someone · Not recorded', { exact: true }).waitFor();
  assert.equal(writes[4].name, 'clear-home-waiting'); assert.equal(writes[4].args.base_version, 2);
  await row.getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /Marked done/ }).waitFor();
  assert.equal(await row.getByText(/Waiting on/).count(), 0);
});
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`directory picker paging and stale search ${width} ${theme}`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  const rpc = fixtureInboxRpc(); const searches = []; const writes = [];
  let releaseOld; let active = 0; let maxActive = 0;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  t.after(() => releaseOld());
  const reviewer = '00000000-0000-0000-0000-000000000099';
  const coordinator = '00000000-0000-0000-0000-000000000098';
  const actor = '00000000-0000-0000-0000-000000000097';
  const cursor = { query: 'demo', name: 'Demo reviewer', id: reviewer };
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', async route => {
    const { name, arguments: args } = route.request().postDataJSON().params;
    let value;
    if (name === 'read-actor-roster-v1') value = { ok: true, schema_version: 'actor-roster.v1', actors: [
      { id: actor, slug: 'demo-partner', display_name: 'Demo partner', kind: 'human' },
      { id: '00000000-0000-0000-0000-000000000096', slug: 'demo-bot', display_name: 'Demo automation', kind: 'automation' },
      { id: '00000000-0000-0000-0000-000000000095', slug: 'demo-system', display_name: 'Demo system', kind: 'system' }
    ] };
    else if (name === 'search-parties-v1') {
      searches.push(args); active++; maxActive = Math.max(active, maxActive);
      if (args.query === 'Old') await oldResponse;
      value = args.query === 'Fail' ? { error: 'network_error' } : { ok: true, schema_version: 'party-search.v1', parties: args.query === 'None' ? [] : [
        { id: reviewer, display_name: args.query === 'Old' ? 'Stale person' : 'Directory reviewer', kind: 'person' },
        ...(args.cursor ? [{ id: coordinator, display_name: 'Directory coordinator', kind: 'person' }] : []),
        { id: '00000000-0000-0000-0000-000000000094', display_name: 'Demo organization', kind: 'org' }
      ], next_cursor: args.query === 'Demo' && !args.cursor ? cursor : null };
      active--;
    } else if (['read-home-inbox-v5', 'email-match-contacts', 'set-home-waiting', 'clear-home-waiting'].includes(name)) {
      if (name === 'set-home-waiting') writes.push(args);
      value = await rpc(name, args);
    } else value = name === 'calendar-meeting-prep' ? { state: 'empty', items: [] } : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    return route.fulfill({ json: { result: { ...(value.error ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  const row = page.locator('[data-inbox-row="demo-review"]');
  await row.getByRole('button', { name: 'Set waiting person', exact: true }).click();
  await row.getByRole('button', { name: 'Load people', exact: true }).click();
  const person = row.getByLabel('Person', { exact: true });
  await person.locator('option', { hasText: 'Demo partner' }).waitFor({ state: 'attached' });
  assert.equal(await person.locator('option', { hasText: /Demo automation|Demo system/ }).count(), 0);
  assert.equal(searches.length, 0);
  const input = row.getByLabel('Search people by name');
  await input.fill('D'); await input.fill('De'); await input.fill('Demo');
  await row.getByRole('button', { name: 'More results', exact: true }).click();
  await person.locator('option', { hasText: 'Directory coordinator' }).waitFor({ state: 'attached' });
  assert.equal(await person.locator(`option[value="${reviewer}"]`).count(), 1);
  assert.equal(await person.locator('option', { hasText: 'Demo organization' }).count(), 0);
  assert.deepEqual(searches.map(args => args.query), ['Demo', 'Demo']);
  assert.deepEqual(searches[1].cursor, cursor);
  await person.selectOption(coordinator);
  await input.fill('Old');
  await row.getByText('Searching people…', { exact: true }).waitFor();
  await input.fill('New');
  await page.waitForTimeout(400);
  assert.equal(searches.length, 3);
  releaseOld();
  await person.locator('option', { hasText: 'Directory reviewer' }).waitFor({ state: 'attached' });
  assert.equal(await person.locator('option', { hasText: 'Stale person' }).count(), 0);
  assert.equal(maxActive, 1);
  assert.equal(await person.inputValue(), coordinator);
  await input.fill('None');
  await row.getByText('No people found for this name prefix.', { exact: true }).waitFor();
  await input.fill('Fail');
  await row.getByRole('button', { name: 'Retry search', exact: true }).waitFor();
  const beforeRetry = searches.length;
  await row.getByRole('button', { name: 'Retry search', exact: true }).click();
  await row.getByRole('button', { name: 'Retry search', exact: true }).waitFor();
  assert.equal(searches.length, beforeRetry + 1);
  await input.fill('');
  await row.getByText('Enter a name prefix to search CARR people.', { exact: true }).waitFor();
  await input.fill('Demo');
  await row.getByRole('button', { name: 'More results', exact: true }).waitFor();
  await person.selectOption(reviewer);
  await row.getByLabel('Reason', { exact: true }).fill('Review the lease');
  await row.getByLabel('Evidence references, one per line').fill('call:synthetic');
  await row.getByText('Who owes the next move?', { exact: true }).click();
  await page.screenshot({ path: `/tmp/WR617.S15.J9-evidence/directory-${width}-${theme}.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await row.getByRole('button', { name: 'Save waiting person', exact: true }).click();
  await row.getByText('Waiting on Demo reviewer', { exact: true }).waitFor();
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].target, { kind: 'party', id: reviewer });
  await page.reload();
  await row.getByText('Waiting on Demo reviewer', { exact: true }).waitFor();
  await row.getByRole('button', { name: 'Correct waiting person', exact: true }).click();
  await row.getByRole('button', { name: 'Load people', exact: true }).click();
  await person.selectOption(actor);
  await row.getByRole('button', { name: 'Save waiting person', exact: true }).click();
  await row.getByText('Waiting on Demo partner', { exact: true }).waitFor();
  assert.deepEqual(writes[1].target, { kind: 'actor', id: actor });
  assert.equal(writes[1].base_version, 1);
  await row.getByRole('button', { name: 'Correct waiting person', exact: true }).click();
  await input.fill('None');
  await row.getByRole('button', { name: 'Close editor', exact: true }).click();
  await row.getByRole('button', { name: 'Correct waiting person', exact: true }).click();
  assert.equal(await input.inputValue(), '');
  assert.equal(await person.inputValue(), '');
});
for (const version of ['v4', 'v5']) test(`Home renders ${version} with waiting controls only on v5`, async t => {
  const server = await fixtureServer({ root: join(outDir, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  const rpc = fixtureInboxRpc();
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic' } }));
  await page.route('**/pipeline/changes*', route => route.fulfill({ json: { events: [], cursor: 'end' } }));
  await page.route('**/mcp', async route => {
    const { name } = route.request().postDataJSON().params;
    const value = name === 'read-home-inbox-v5' && version === 'v4' ? { error: 'unknown_tool' }
      : name === `read-home-inbox-${version}` ? await rpc(name, {})
      : name === 'deal-room-board' ? { actor: 'joe', deals: [] } : { items: [] };
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(value) }] } } });
  });
  await page.goto(`${server.origin}/?mode=live`);
  const row = page.locator('[data-inbox-row="demo-review"]');
  await row.getByText('Review the practice tour follow-up', { exact: true }).waitFor();
  assert.equal(await page.getByText('Inbox unavailable', { exact: true }).count(), 0);
  assert.equal(await row.getByRole('button', { name: 'Set waiting person', exact: true }).count(), version === 'v5' ? 1 : 0);
  assert.equal(await row.getByText(/Waiting on/).count(), version === 'v5' ? 1 : 0);
});
