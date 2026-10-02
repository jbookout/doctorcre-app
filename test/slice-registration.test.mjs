import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { assertSliceOwnership, assembleSlices, prepareSlices } from '../scripts/slices.mjs';
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
  await writeFile(join(root, 'progress-board.html'), '<main>Demo unchanged progress</main>');
  await writeFile(join(root, 'js/app-shell.js'), '// Demo shared shell remains unchanged');
  const before = await Promise.all(['progress-board.html', 'js/app-shell.js'].map(p => readFile(join(root, p), 'utf8')));
  for (const [index, id] of ['alpha', 'beta'].entries()) {
    const slice = definition(id);
    slice.navigation[0].order += index;
    await writeFile(join(root, `js/slices/${id}.js`), `export default ${JSON.stringify(slice)};`);
    await writeFile(join(root, `contracts/routes/${id}.json`), JSON.stringify({ routes: [{ path: `/${id}`, asset: `${id}.html`, order: index }], redirects: [] }));
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
  const a = definition('alpha'), b = definition('beta');
  assert.throws(() => assembleSlices([a, b], [
    { routes: [{ path: '/same', asset: 'alpha.html', order: 0 }] },
    { routes: [{ path: '/same', asset: 'beta.html', order: 1 }] },
  ], { schema: 'doctorcre-app-routes.v1', version: '1.19.0' }), /duplicate route.*\/same/);
});
