import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { assertSliceOwnership, assembleSlices, prepareSlices } from '../scripts/slices.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { registerSlices, mountSliceSections } from '../js/slice-registration.js';

const definition = id => ({ id, files: [`${id}.html`, `test/${id}.test.mjs`], navigation: [{ label: id, href: `/${id}`, order: 100, group: 'Workspace' }], sections: [{ page: '/alpha', slot: 'main', id: `${id}-panel`, html: `<section id="${id}-panel">Demo ${id}</section>` }] });

test('two slices cannot write the same shared file', () => {
  const a = definition('alpha'), b = definition('beta');
  a.files.push('progress-board.html'); b.files.push('progress-board.html');
  assert.throws(() => assertSliceOwnership([a, b]), /progress-board.html.*alpha.*beta/);
  b.files.pop();
  assert.doesNotThrow(() => assertSliceOwnership([a, b]), 'one existing slice may own its page');
  b.files.push('js/app-shell.js');
  assert.throws(() => assertSliceOwnership([a, b]), /shared integration file.*js\/app-shell.js/);
});

test('two new slices add route, navigation and page sections without shared source edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-slices-'));
  await mkdir(join(root, 'js/slices'), { recursive: true });
  await mkdir(join(root, 'contracts/routes'), { recursive: true });
  await writeFile(join(root, 'contracts/routes.v1.json'), JSON.stringify({ schema: 'doctorcre-app-routes.v1', version: '1.19.0' }));
  await writeFile(join(root, 'contracts/slice-ownership.v1.json'), JSON.stringify({ schema: 'doctorcre-slice-ownership.v1', shared: ['js/app-shell.js'] }));
  await writeFile(join(root, 'progress-board.html'), '<main>Demo unchanged progress</main>');
  await writeFile(join(root, 'js/app-shell.js'), '// Demo shared shell remains unchanged');
  const before = await Promise.all(['progress-board.html', 'js/app-shell.js'].map(p => readFile(join(root, p), 'utf8')));
  for (const [index, id] of ['alpha', 'beta'].entries()) {
    const slice = definition(id);
    slice.files.push(`contracts/${id}.v1.json`);
    await writeFile(join(root, `contracts/${id}.v1.json`), JSON.stringify({ schema: `demo-${id}.v1` }));
    slice.navigation[0].order += index;
    await writeFile(join(root, `js/slices/${id}.js`), `export default ${JSON.stringify(slice)};`);
    await writeFile(join(root, `contracts/routes/${id}.json`), JSON.stringify({ routes: [{ path: `/${id}`, asset: `${id}.html`, order: index, gatePath: '/control-room' }], redirects: [] }));
    await writeFile(join(root, `${id}.html`), `<main>Demo ${id}</main>`);
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, `test/${id}.test.mjs`), '// Demo local tests');
  }
  const { slices, contract } = await prepareSlices(root);
  assert.deepEqual(contract.routes, { '/alpha': 'alpha.html', '/beta': 'beta.html' });
  assert.deepEqual(registerSlices(slices).navigationItems.map(n => n.label), ['alpha', 'beta']);
  const dom = new JSDOM('<main></main>');
  mountSliceSections(dom.window.document, '/alpha', slices);
  mountSliceSections(dom.window.document, '/alpha', slices);
  assert.deepEqual([...dom.window.document.querySelectorAll('main section')].map(n => n.id), ['alpha-panel', 'beta-panel']);
  assert.deepEqual(await Promise.all(['progress-board.html', 'js/app-shell.js'].map(p => readFile(join(root, p), 'utf8'))), before);
  for (const directory of ['css', 'data', 'public-shell', 'reports', 'tours']) await mkdir(join(root, directory));
  await writeFile(join(root, 'manifest.webmanifest'), '{}');
  await writeFile(join(root, 'contracts/carr-interface.v1.json'), JSON.stringify({ schema: 'doctorcre-carr-interface.v1', version: '1.0.0' }));
  await writeFile(join(root, 'contracts/runtime-errors.v1.json'), JSON.stringify({ schema: 'carr-runtime-errors.v1', version: '1.0.0' }));
  const artifact = await buildArtifact({ root, outDir: join(root, 'dist'), commit: '1'.repeat(40) });
  assert.ok(artifact.manifest.files.some(file => file.path === 'alpha.html'));
  assert.ok(artifact.manifest.files.some(file => file.path === 'beta.html'));
  assert.equal(await readFile(join(root, 'dist/site/contracts/alpha.v1.json'), 'utf8'), JSON.stringify({ schema: 'demo-alpha.v1' }));
  assert.ok(!artifact.manifest.files.some(file => file.path.startsWith('test/')));
  const a = definition('alpha'), b = definition('beta');
  assert.throws(() => assembleSlices([a, b], [
    { routes: [{ path: '/same', asset: 'alpha.html', order: 0 }] },
    { routes: [{ path: '/same', asset: 'beta.html', order: 1 }] },
  ], { schema: 'doctorcre-app-routes.v1', version: '1.19.0' }), /duplicate route.*\/same/);
});

test('a registered section mounts its own controls module once after its markup', () => {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost/' });
  const slice = definition('alpha');
  slice.sections[0].module = '/js/alpha-controls.js';
  for (let i = 0; i < 2; i++) mountSliceSections(dom.window.document, '/alpha', [slice]);
  const script = dom.window.document.querySelector('script[type="module"]');
  assert.equal(script?.getAttribute('src'), '/js/alpha-controls.js');
  assert.equal(dom.window.document.querySelectorAll('script').length, 1);
  assert.equal(script.previousElementSibling.id, 'alpha-panel');
});

test('shared Doc modules remain admitted to the assembled application', async () => {
  const { shared } = await prepareSlices(new URL('../', import.meta.url).pathname);
  for (const path of ['js/doc-presence.js', 'js/doc-context.js', 'js/doc-context-model.js', 'js/doc-approval.js', 'js/doc-accuracy.js', 'css/doc-presence.css', 'test/doc-context.test.mjs', 'test/doc-presence-browser.test.mjs']) {
    assert.ok(shared.includes(path), `shared Doc input is admitted: ${path}`);
  }
});
