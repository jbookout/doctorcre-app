import { expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const origin = 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev';

async function call(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const response = await request.post(`${origin}/mcp`, {
    headers: { origin, 'sec-fetch-site': 'same-origin' },
    data: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.error).toBeUndefined();
  const text = body.result?.content?.find((item: { type: string }) => item.type === 'text')?.text;
  expect(typeof text).toBe('string');
  const value = JSON.parse(text);
  expect(value.error, `${name} must support synthetic staging fixtures`).toBeUndefined();
  return value;
}

export async function createLoopFixture(request: APIRequestContext, kind: 'team_loop' | 'idea' | 'open_loop') {
  const title = `Synthetic staging QA ${randomUUID()}`;
  const created = await call(request, 'add-loop', {
    idempotency_key: randomUUID(), kind, owner: 'joe', title, body: title,
    source_note: 'signed-in-e2e-synthetic-fixture',
    ...(kind === 'open_loop' ? { blocker: 'other_lane',
      blocker_detail: 'Synthetic fixture waits for its Playwright browser verification to finish.' } : {}),
  });
  expect(created.ok).toBe(true);
  expect(typeof created.loop_id).toBe('string');
  return {
    title,
    async cleanup() {
      const { loop: current } = await call(request, 'read-loop', { loop_id: created.loop_id });
      expect(current.title).toBe(title);
      expect(current.status).toBe('open');
      const closed = await call(request, 'close-loop', {
        idempotency_key: randomUUID(), loop_id: created.loop_id, base_version: current.version,
        resolution: 'done', outcome: 'Synthetic browser fixture completed and cleaned up.',
      });
      expect(closed.ok).toBe(true);
      const { loop: after } = await call(request, 'read-loop', { loop_id: created.loop_id });
      expect(after.status).toBe('done');
    },
  };
}
