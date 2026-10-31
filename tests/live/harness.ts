// Live journeys: the built app, through its own Worker, against the real CARR
// Worker on a disposable migrated database (carr-system's local-carr harness).
//
// CARR_PRODUCER_CHECKOUT names the carr-system checkout at the pinned producer
// commit, with mcp-server dependencies and the Python lock installed. The app
// listens on 127.0.0.1:8787, a local origin the Call Mode companion admits.
import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_ORIGIN = 'http://127.0.0.1:8787';
const COMPANION = 'http://127.0.0.1:4682';
const SITE = resolve(import.meta.dirname, '../../dist/site');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

/** One filed (or failed) call: its companion and session name. */
export type FiledCall = { url: string; name: string; logs(): string };
export type LocalCarr = {
  url: string; e2eSecret: string; deals: Record<string, string>; setupMs: number;
  mcp(name: string, args?: object): Promise<any>;
  fileCall(options?: { distiller?: 'stand-in' | 'failing' }): Promise<FiledCall>;
  close(): Promise<void>;
};

async function asset(request: Request) {
  const path = resolve(SITE, `.${new URL(request.url).pathname}`);
  const inside = relative(SITE, path);
  if (inside.startsWith('..') || isAbsolute(inside)) return new Response('Not found', { status: 404 });
  try {
    if (!(await stat(path)).isFile()) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : await readFile(path),
      { headers: { 'content-type': MIME[extname(path)] || 'application/octet-stream' } });
  } catch { return new Response('Not found', { status: 404 }); }
}

async function serveApp(carr: LocalCarr): Promise<Server> {
  const { handleDoctorcreRequest } = await import('../../src/worker.js');
  // The app Worker's CARR service binding, pointed at the local CARR Worker.
  const CARR = { fetch: (request: Request) => {
    const url = new URL(request.url);
    return fetch(`${carr.url}${url.pathname}${url.search}`, { method: request.method, headers: request.headers,
      body: request.body, redirect: 'manual', duplex: 'half' } as RequestInit);
  } };
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers))
      for (const item of [value ?? []].flat()) headers.append(name, item);
    const request = new Request(new URL(incoming.url || '/', APP_ORIGIN), { method: incoming.method, headers,
      ...(chunks.length ? { body: Buffer.concat(chunks), duplex: 'half' } : {}) } as RequestInit);
    const response: Response = await handleDoctorcreRequest(request, { ASSETS: { fetch: asset }, CARR, APP_ENV: 'local',
      GIT_SHA: '0'.repeat(40) });
    const out: Record<string, string | string[]> = Object.fromEntries(response.headers);
    if (response.headers.getSetCookie().length) out['set-cookie'] = response.headers.getSetCookie();
    outgoing.writeHead(response.status, out);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>(done => server.listen(Number(new URL(APP_ORIGIN).port), '127.0.0.1', done));
  return server;
}

export const test = base.extend<{ signedIn: Page; companion: (call: FiledCall) => Promise<void> },
  { carr: LocalCarr; app: Server }>({
  carr: [async ({}, use) => {
    const checkout = process.env.CARR_PRODUCER_CHECKOUT;
    if (!checkout) throw new Error('CARR_PRODUCER_CHECKOUT must name the carr-system checkout for live journeys');
    const { startLocalCarr } = await import(pathToFileURL(resolve(checkout, 'mcp-server/test/helpers/local-carr.mjs')).href);
    const carr: LocalCarr = await startLocalCarr({ assets: asset });
    console.log(`live harness: local CARR ready in ${carr.setupMs}ms`);
    await use(carr);
    await carr.close();
  }, { scope: 'worker', timeout: 180_000 }],
  app: [async ({ carr }, use) => {
    const server = await serveApp(carr);
    await use(server);
    await new Promise(done => server.close(done));
  }, { scope: 'worker' }],
  // A page signed in as the synthetic partner through the staging e2e door.
  signedIn: async ({ page, app, carr }, use) => {
    void app;
    const response = await page.request.post(`${APP_ORIGIN}/auth/e2e-session`,
      { headers: { authorization: `Bearer ${carr.e2eSecret}` }, maxRedirects: 0 });
    expect(response.status()).toBe(200);
    await page.addInitScript(() => localStorage.setItem('doctorcre.visual-preferences',
      JSON.stringify({ walkthroughSeen: { joe: true, dell: true } })));
    await use(page);
  },
  // The browser's Call Mode requests reach this call's companion. The page
  // keeps its real origin; only the loopback port differs.
  companion: async ({ page }, use) => {
    await use(async call => {
      await page.route(`${COMPANION}/**`, route => route.continue({ url: route.request().url().replace(COMPANION, call.url) }));
    });
  },
});
export { expect };
