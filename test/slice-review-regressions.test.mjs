import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { prepareSlices, assertSliceOwnership } from '../scripts/slices.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { registerSlices } from '../js/slice-registration.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-slice-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(repo, root, { recursive: true, filter: path => !['.git', 'node_modules', 'dist', 'test-artifacts'].includes(relative(repo, path).split('/')[0]) });
  return root;
}
async function addSlice(root, { slot = 'main', id = 'alpha-panel', html = `<section id="${id}"><button id="alpha-action">Run demo</button></section>`, module = '/js/alpha-controls.js', page = '/' } = {}) {
  const slice = { id: 'alpha', files: ['alpha.html', 'js/alpha-controls.js', 'test/alpha.test.mjs'],
    navigation: [{ label: 'Alpha', href: '/alpha', group: 'Workspace', order: 100 }],
    sections: [{ page, slot, id, html, module }] };
  await writeFile(join(root, 'js/slices/alpha.js'), `export default ${JSON.stringify(slice)};`);
  await writeFile(join(root, 'contracts/routes/alpha.json'), JSON.stringify({ routes: [{ path: '/alpha', asset: 'alpha.html', order: 100, gatePath: '/control-room' }] }));
  await writeFile(join(root, 'alpha.html'), '<main>Demo Alpha</main>');
  await writeFile(join(root, 'js/alpha-controls.js'), `document.querySelector('#alpha-action').onclick = () => { document.querySelector('#alpha-action').textContent = 'Demo ran'; };`);
  await writeFile(join(root, 'test/alpha.test.mjs'), '// Synthetic feature test');
  return slice;
}

test('finding 1: a slice-owned gate works through the Worker, with refusal, cookies and return_to preserved', async t => {
  const root = await fixture(t); await addSlice(root); await prepareSlices(root);
  const { handleDoctorcreRequest } = await import(pathToFileURL(join(root, 'src/worker.js')));
  const paths = [], assets = [];
  const env = { CARR: { fetch: async request => {
    paths.push(new URL(request.url).pathname);
    assert.equal(request.headers.get('cookie'), 'synthetic-session=demo');
    return new URL(request.url).pathname === '/control-room'
      ? new Response(null, { headers: { 'set-cookie': 'synthetic-session=renewed' } }) : new Response(null, { status: 404 });
  } }, ASSETS: { fetch: async request => { assets.push(new URL(request.url).pathname); return new Response('Demo Alpha'); } } };
  const request = new Request('https://app.example.test/alpha?view=demo', { headers: { cookie: 'synthetic-session=demo' } });
  const response = await handleDoctorcreRequest(request, env);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'Demo Alpha');
  assert.deepEqual(paths, ['/control-room']); assert.deepEqual(assets, ['/alpha.html']);
  assert.equal(response.headers.get('set-cookie'), 'synthetic-session=renewed');
  env.CARR.fetch = async () => new Response(null, { status: 302, headers: { location: '/auth/login?return_to=%2Fcontrol-room' } });
  const signedOut = await handleDoctorcreRequest(request, env);
  assert.equal(new URL(signedOut.headers.get('location')).searchParams.get('return_to'), '/alpha?view=demo');
  env.CARR.fetch = async () => new Response(null, { status: 401 });
  assert.equal((await handleDoctorcreRequest(request, env)).status, 401);
  env.CARR.fetch = async () => { throw new Error('Demo outage'); };
  assert.equal((await handleDoctorcreRequest(request, env)).status, 503);
  assert.deepEqual(assets, ['/alpha.html'], 'refusal and outage never read the page asset');
});

test('finding 2: existing controls, styles and feature tests cannot be claimed by another slice', async () => {
  const { slices } = await prepareSlices(repo);
  for (const file of ['js/progress-board.js', 'css/progress-board.css', 'test/progress-board.test.mjs']) {
    assert.throws(() => assertSliceOwnership([...slices, { id: 'alpha', files: [file] }]), /progress.*alpha|alpha.*progress/, file);
  }
  assert.throws(() => assertSliceOwnership([{ id: 'alpha', files: ['js/client.js'] }]), /shared integration file/);
});

test('finding 3: unsupported controls locations are refused before artifact deployment', async t => {
  const root = await fixture(t);
  const slice = await addSlice(root, { module: '/alpha-controls.js' }); slice.files.push('alpha-controls.js');
  await writeFile(join(root, 'alpha-controls.js'), '// Demo');
  await writeFile(join(root, 'js/slices/alpha.js'), `export default ${JSON.stringify(slice)};`);
  await assert.rejects(prepareSlices(root), /section module.*deploy|unsupported.*module/);
});

test('finding 3: supported controls ship, route publicly, and feature tests stay outside the artifact', async t => {
  const root = await fixture(t); await addSlice(root); await prepareSlices(root);
  const built = await buildArtifact({ root, outDir: join(root, 'dist'), commit: '1'.repeat(40) });
  assert.ok(built.manifest.files.some(file => file.path === 'js/alpha-controls.js'));
  assert.ok(!built.manifest.files.some(file => file.path.startsWith('test/')));
  const { handleDoctorcreRequest } = await import(pathToFileURL(join(root, 'src/worker.js')));
  let carrCalls = 0;
  const response = await handleDoctorcreRequest(new Request('https://app.example.test/js/alpha-controls.js'), {
    CARR: { fetch: () => { carrCalls++; throw new Error('unexpected gate'); } },
    ASSETS: { fetch: async request => new Response(await readFile(join(root, 'dist/site', new URL(request.url).pathname))) },
  });
  assert.match(await response.text(), /Demo ran/); assert.equal(carrCalls, 0);
});

for (const slot of ['#missing-slot', '[']) test(`finding 4: invalid page slot ${slot} is refused before delivery`, async t => {
  const root = await fixture(t); await addSlice(root, { slot });
  await assert.rejects(prepareSlices(root), /section slot/);
});

test('finding 5: page IDs cannot silently swallow a registered section', async t => {
  const root = await fixture(t); await addSlice(root, { id: 'appShell' });
  await assert.rejects(prepareSlices(root), /section.*id.*collision|duplicate.*id/);
});

async function open(t, root, { failControls = false, runtimeOnly = false } = {}) {
  const registration = await prepareSlices(root);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let controlsRequests = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/js/alpha-controls.js') { controlsRequests++; if (failControls && controlsRequests === 1) return route.abort(); }
    if (url.pathname === '/api/system-work/session') return route.fulfill({ json: { actor: { slug: 'joe' } } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return route.fulfill({ json: {} });
    const file = registration.contract.routes[url.pathname] || url.pathname.slice(1);
    try {
      let body = await readFile(join(root, file));
      // Runtime drift must not remove navigation even if build validation was bypassed.
      if (runtimeOnly && file === 'js/slices/alpha.js') body = Buffer.from(String(body).replace('"slot":"main"', '"slot":"#missing-slot"'));
      return route.fulfill({ body, contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/');
  return { page, errors, requests: () => controlsRequests, registration };
}

for (const slot of ['#appMainSlot', '#appSidebarSlot']) test(`finding 4: actual shell mounts a section in ${slot} and executes its controls`, async t => {
  const root = await fixture(t); await addSlice(root, { slot });
  const { page, errors } = await open(t, root);
  await page.waitForFunction(() => !!document.querySelector('#alpha-action')?.onclick, null, { timeout: 3000 });
  assert.equal(await page.locator(`${slot} #alpha-panel`).count(), 1);
  await page.locator('#alpha-action').evaluate(button => button.click());
  assert.equal(await page.locator('#alpha-action').textContent(), 'Demo ran');
  assert.ok(await page.locator('[data-app-nav-item]').count() > 0); assert.deepEqual(errors, []);
});

test('finding 4: section-contributed layout-slot nodes keep their destination', async t => {
  const root = await fixture(t);
  await addSlice(root, { html: '<section id="alpha-panel" data-layout-slot="sidebar"><button id="alpha-action">Run demo</button></section>' });
  const { page, errors } = await open(t, root);
  await page.waitForFunction(() => !!document.querySelector('#alpha-action')?.onclick);
  assert.equal(await page.locator('#appSidebarSlot #alpha-panel').count(), 1); assert.deepEqual(errors, []);
});

test('finding 4: a runtime section failure leaves global navigation usable', async t => {
  const root = await fixture(t); await addSlice(root);
  const { page, errors } = await open(t, root, { runtimeOnly: true });
  await page.waitForSelector('[data-app-nav-item]', { timeout: 3000 });
  assert.ok(await page.locator('#appLayout').count());
  assert.match(await page.locator('[data-slice-error]').textContent(), /unavailable/i);
  await page.getByLabel('More', { exact: true }).click();
  assert.equal(await page.locator('.app-shell-more-list').isVisible(), true); assert.deepEqual(errors, []);
});

test('finding 6: failed controls show an unavailable state and retry initializes existing markup', async t => {
  const root = await fixture(t); await addSlice(root);
  const { page, errors, requests } = await open(t, root, { failControls: true });
  const retry = page.getByRole('button', { name: 'Retry controls' }); await retry.waitFor({ timeout: 3000 });
  assert.equal(await page.locator('#alpha-panel').getAttribute('data-slice-state'), 'failed');
  assert.equal(await page.locator('#alpha-panel').evaluate(node => node.inert), true);
  assert.match(await page.locator('[data-slice-error]').textContent(), /controls unavailable/i);
  await retry.click(); await page.waitForFunction(() => !!document.querySelector('#alpha-action')?.onclick);
  assert.equal(await page.locator('#alpha-panel').evaluate(node => node.inert), false);
  await page.locator('#alpha-action').click(); assert.equal(await page.locator('#alpha-action').textContent(), 'Demo ran');
  assert.equal(requests(), 2); assert.equal(await page.locator('#alpha-panel').count(), 1);
  await page.evaluate(async () => { const { mountSliceSections } = await import('/js/slice-registration.js'); const { slices } = await import('/js/slices.generated.js'); mountSliceSections(document, '/', slices); });
  assert.equal(requests(), 2, 'ready sections initialize once'); assert.deepEqual(errors, []);
});

test('finding 7: a late Workspace entry keeps desktop/phone expectations in rendered group order', async t => {
  const root = await fixture(t); await addSlice(root);
  const { page, registration, errors } = await open(t, root);
  const expected = registerSlices(registration.slices).navigationItems.map(item => item.label);
  await page.waitForSelector('[data-app-nav-item]');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    assert.deepEqual(await page.locator('[data-app-nav-item]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), expected);
  }
  assert.deepEqual(errors, []);
});
