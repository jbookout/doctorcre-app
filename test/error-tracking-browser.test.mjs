import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium, settles } from './browser-harness.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';

test('the built bootstrap catches browser throws and rejected promises before app code', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const outDir = join(root, 'out/_to_delete/error-tracking-browser', crypto.randomUUID());
  await mkdir(outDir, { recursive: true });
  const release = 'd'.repeat(40);
  await buildArtifact({ root, outDir, commit: release });
  const workspace = await readFile(join(outDir, 'site/workspace.html'), 'utf8');
  assert.match(workspace, /<head><script type="module" src="\/js\/error-tracking-entry.js"><\/script>/);
  const entry = await readFile(join(outDir, 'site/js/error-tracking-entry.js'), 'utf8');
  assert.ok(entry.includes(release));
  const reports = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/v1/runtime-errors') {
      let body = ''; for await (const chunk of request) body += chunk;
      reports.push(JSON.parse(body)); response.writeHead(202, { 'content-type': 'application/json' }); response.end('{"ok":true}'); return;
    }
    if (request.url.startsWith('/js/')) {
      try { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(await readFile(join(outDir, 'site', request.url))); }
      catch { response.end(''); }
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><head><script type="module" src="/js/error-tracking-entry.js"></script></head><body>synthetic fixture</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/clients/Alice?email=alice@example.test`);
    await page.waitForFunction(() => typeof window.onerror === 'function');
    await page.evaluate(() => {
      setTimeout(() => { throw new TypeError('Cannot read properties of Alice alice@example.test medical contents'); }, 0);
      Promise.reject(new Error('Alice alice@example.test medical contents'));
    });
    await settles(() => assert.equal(reports.length, 2));
    assert.deepEqual(new Set(reports.map(report => report.type)), new Set(['Error', 'TypeError']));
    assert.ok(reports.every(report => report.release_sha === release && report.route === '/clients/:value'));
    assert.doesNotMatch(JSON.stringify(reports), /Alice|example|medical|contents/);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
