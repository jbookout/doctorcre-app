// Live journeys: the built app, through its own Worker, against the real CARR
// Worker on a disposable migrated database (carr-system's local-carr harness).
//
// CARR_PRODUCER_CHECKOUT names the carr-system checkout at the pinned producer
// commit, with mcp-server dependencies and the Python lock installed. The app
// listens on 127.0.0.1:8787, a local origin the Call Mode companion admits.
import { test as base, expect, type Page } from '@playwright/test';
import { startWorkerFixture } from '../../scripts/fixture-http.mjs';
import { appAssetSnapshot } from '../../scripts/fixture-app-assets.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_ORIGIN = 'http://127.0.0.1:8787';
const COMPANION = 'http://127.0.0.1:4682';
const SITE = resolve(import.meta.dirname, '../../dist/site');
let prepared: ReturnType<typeof appAssetSnapshot>;
const snapshot = () => prepared ||= appAssetSnapshot(SITE);
type AppFixture = Awaited<ReturnType<typeof startWorkerFixture>>;

/** One filed (or failed) call: its companion and session name. */
export type FiledCall = { url: string; name: string; logs(): string };
export type LocalCarr = {
  url: string; e2eSecret: string; deals: Record<string, string>; setupMs: number;
  mcp(name: string, args?: object): Promise<any>;
  fileCall(options?: { distiller?: 'stand-in' | 'failing' }): Promise<FiledCall>;
  close(): Promise<void>;
};

async function asset(request: Request) {
  const descriptor = (await snapshot()).get(new URL(request.url).pathname);
  return descriptor ? new Response(request.method === 'HEAD' ? null : descriptor.body,
    {headers:{'content-type':descriptor.contentType}}) : new Response('Not found',{status:404});
}

async function serveApp(carr: LocalCarr): Promise<AppFixture> {
  // The app Worker's CARR service binding, pointed at the local CARR Worker.
  const CARR = { fetch: (request: Request) => {
    const url = new URL(request.url);
    return fetch(`${carr.url}${url.pathname}${url.search}`, { method: request.method, headers: request.headers,
      body: request.body, signal:request.signal, redirect: 'manual', duplex: 'half' } as RequestInit);
  } };
  return startWorkerFixture({assets:await snapshot(),port:Number(new URL(APP_ORIGIN).port),
    env:{CARR,APP_ENV:'local',GIT_SHA:'0'.repeat(40)}});
}

export const test = base.extend<{ signedIn: Page; companion: (call: FiledCall) => Promise<void> },
  { carr: LocalCarr; app: AppFixture }>({
  carr: [async ({}, use) => {
    const checkout = process.env.CARR_PRODUCER_CHECKOUT;
    if (!checkout) throw new Error('CARR_PRODUCER_CHECKOUT must name the carr-system checkout for live journeys');
    const { startLocalCarr } = await import(pathToFileURL(resolve(checkout, 'mcp-server/test/helpers/local-carr.mjs')).href);
    await snapshot();
    const carr: LocalCarr = await startLocalCarr({ assets: asset });
    console.log(`live harness: local CARR ready in ${carr.setupMs}ms`);
    await use(carr);
    await carr.close();
  }, { scope: 'worker', timeout: 180_000 }],
  app: [async ({ carr }, use) => {
    const server = await serveApp(carr);
    await use(server);
    await server.close();
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
