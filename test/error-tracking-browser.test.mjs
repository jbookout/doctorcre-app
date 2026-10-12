import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium, settles } from './browser-harness.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { createDoctorcreRequestHandler } from '../src/worker.js';

// The application module throws while it is first evaluated, so the report can
// only exist if the built bootstrap installed its listeners before app code ran.
const APP_MODULE = `
window.onerror = () => { window.appOnError = (window.appOnError || 0) + 1; };
window.onunhandledrejection = () => { window.appOnRejection = (window.appOnRejection || 0) + 1; };
Promise.reject({ get name() { throw new Error('Alice'); }, get message() { throw new Error('Alice'); } });
Promise.reject(new Error('Alice alice@example.test medical contents'));
for (let index = 0; index < 25; index++) setTimeout(() => { throw new RangeError('Alice loop ' + index); }, 0);
throw new TypeError('Cannot read properties of Alice alice@example.test medical contents');
`;

test('the built bootstrap reports errors thrown while application modules first evaluate', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const outDir = join(root, 'out/_to_delete/error-tracking-browser', crypto.randomUUID());
  await mkdir(outDir, { recursive: true });
  const release = 'd'.repeat(40);
  await buildArtifact({ root, outDir, commit: release });
  const workspace = await readFile(join(outDir, 'site/workspace.html'), 'utf8');
  const bootstrap = '<script type="module" src="/js/error-tracking-entry.js"></script>';
  assert.ok(workspace.indexOf(bootstrap) >= 0 && workspace.indexOf(bootstrap) < workspace.indexOf('<script', workspace.indexOf(bootstrap) + 1),
    'the bootstrap is the first script on the page');
  const head = workspace.slice(0, workspace.indexOf('</head>'));
  assert.equal(head.indexOf('<script'), head.indexOf(bootstrap));

  const forwarded = [];
  const edge = createDoctorcreRequestHandler();
  const env = { CARR: { fetch: async request => { forwarded.push(JSON.parse(await request.text())); return Response.json({ ok: true }, { status: 202 }); } } };
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/api/v1/runtime-errors') {
      let body = ''; for await (const chunk of request) body += chunk;
      const answer = await edge(new Request(origin + request.url, { method: request.method, headers: request.headers, body }), env, {});
      response.writeHead(answer.status, { 'content-type': 'application/json' }); response.end(await answer.text()); return;
    }
    if (request.url === '/js/app.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(APP_MODULE); return; }
    if (request.url.startsWith('/js/')) {
      try { const file = await readFile(join(outDir, 'site', request.url)); response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(file); }
      catch { response.writeHead(404); response.end(''); }
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><head>${bootstrap}<script type="module" src="/js/app.js"></script></head><body>synthetic fixture</body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/clients/Alice?email=alice@example.test`);
    await settles(() => assert.equal(forwarded.filter(report => report.type === 'TypeError').length, 1));
    await settles(async () => assert.deepEqual(await page.evaluate(() => [window.appOnError, window.appOnRejection]), [26, 2]),
      'the application keeps its own error handlers, including for the hostile rejection');
    await settles(() => assert.equal(forwarded.length, 4));
    assert.deepEqual(forwarded.map(report => report.type).sort(), ['Error', 'RangeError', 'TypeError', 'UnhandledRejection'],
      'the hostile rejection is reported without its throwing fields and the 25 repeated throws once');
    assert.ok(forwarded.every(report => report.release_sha === release && report.route === '/clients/:value'));
    assert.doesNotMatch(JSON.stringify(forwarded), /Alice|example|medical|contents/);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
