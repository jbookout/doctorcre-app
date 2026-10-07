import { test as base } from '@e2e-dev/web';
import { z } from 'zod';

export const QA_NAMESPACE = process.env.QA_NAMESPACE || 'round2';
export const Viewers = ['joe', 'dell'] satisfies ('joe' | 'dell')[];
export const Variants = ['realistic', 'large', 'empty'] satisfies ('realistic' | 'large' | 'empty')[];
export type Viewer = typeof Viewers[number];
export type FixtureVariant = typeof Variants[number];
export const Identity = z.object({synthetic:z.literal(true),viewer:z.enum(['joe','dell']),namespace:z.string()});
export const Board = z.object({schema_version:z.literal('local-deals-board.v1'),actor:z.enum(['joe','dell']),deals:z.array(z.object({id:z.string(),name:z.string(),owner:z.enum(['joe','dell']),version:z.number().int().positive(),attention:z.boolean()}))});
export const LeadWorkspace = z.object({schema_version:z.literal('lead-workspace.v1'),leads:z.array(z.object({id:z.string(),name:z.string(),doctor_name:z.string(),stage:z.string()}))});
export const Invoices = z.object({schema_version:z.literal('invoice-tracker.v1'),actor:z.enum(['joe','dell']),entries:z.array(z.object({name:z.string(),owner:z.enum(['joe','dell']),status:z.string().nullable()}))});
export const Deal = z.object({owner:z.enum(['joe','dell'])});
export const Mutation = z.object({ok:z.literal(true)});
export const Refusal = z.object({error:z.string()});
export const Feed = z.object({events:z.array(z.object({actor:z.enum(['joe','dell'])}))});
const Seed = Identity.extend({variant:z.enum(['realistic','large','empty']),counts:z.object({deals:z.number().int().nonnegative(),leads:z.number().int().nonnegative(),invoices:z.number().int().nonnegative()}),cookie:z.object({name:z.string(),value:z.string(),url:z.string().url(),httpOnly:z.boolean(),sameSite:z.literal('Lax')})});
const RpcEnvelope = z.union([
  z.object({result:z.object({isError:z.boolean().optional(),content:z.tuple([z.object({type:z.literal('text'),text:z.string()})]).rest(z.unknown())})}),
  z.object({error:z.union([z.string(),z.object({code:z.number(),message:z.string()})])}),
]);
export function baseUrl(app: {baseUrl:string | undefined}) { return z.string().url().parse(app.baseUrl); }
export async function seedFixture(url: string, namespace: string, viewer: Viewer, variant: FixtureVariant = 'realistic', reset = false) {
  const response = await fetch(new URL('/api/test/seed', url), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ namespace, viewer, variant, reset }),
  });
  if (!response.ok) throw new Error(`Fixture seed failed: HTTP ${response.status}`);
  const value: unknown = await response.json();
  return Seed.parse(value);
}
export async function rpc(request: (path: string, init?: RequestInit) => Promise<Response>, name: string, args: Record<string, unknown> = {}) {
  const response = await request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const body: unknown = await response.json();
  const envelope = RpcEnvelope.parse(body);
  const payload: unknown = 'result' in envelope ? JSON.parse(envelope.result.content[0].text) : envelope;
  return { response, payload, refused: 'result' in envelope && envelope.result.isError === true };
}
export const test = base.extend<{ api: (path: string, init?: RequestInit) => Promise<Response> }>({
  api: async ({ app, browser }, use) => {
    const origin = baseUrl(app);
    await use(async (path, init) => {
      const url = new URL(path, origin);
      if (url.origin !== new URL(origin).origin) throw new Error('QA API requests must stay on the app origin');
      const headers = new Headers(init?.headers);
      headers.set('cookie', (await browser.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
      return fetch(url, { ...init, headers });
    });
  },
});
