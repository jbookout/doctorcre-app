import { test as base } from '@e2e-dev/web';

// Signed-in API calls, per docs/api-testing.mdx: send the restored session's
// cookies with each request, refusing anything off the staging origin.
export type Verb = (name: string, args?: Record<string, unknown>) => Promise<{ status: number; isError: boolean; data: any }>;

export const test = base.extend<{ api: (path: string, init?: RequestInit) => Promise<Response> }>({
  api: async ({ app, browser }, use) => {
    await use(async (path, init) => {
      const url = new URL(path, app.baseUrl);
      if (url.origin !== new URL('/', app.baseUrl).origin) throw new Error(`${url} is not on the app`);
      const headers = new Headers(init?.headers);
      headers.set('cookie', (await browser.cookies()).map(c => `${c.name}=${c.value}`).join('; '));
      // A browser sends Origin on every same-origin POST; CARR's CSRF check requires it.
      if ((init?.method ?? 'GET') !== 'GET') headers.set('origin', url.origin);
      return fetch(url, { ...init, headers, redirect: 'manual' });
    });
  },
});

// One record-layer verb through the app's own transport: POST /mcp, JSON-RPC tools/call.
export const verbTest = test.extend<{ verb: Verb }>({
  verb: async ({ api }, use) => {
    await use(async (name, args = {}) => {
      const response = await api('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const body: any = await response.json().catch(() => ({}));
      const text = body?.result?.content?.[0]?.text;
      let data: any = body?.result?.structuredContent ?? null;
      if (data === null && typeof text === 'string') { try { data = JSON.parse(text); } catch { data = text; } }
      return { status: response.status, isError: Boolean(body?.result?.isError || body?.error), data };
    });
  },
});
