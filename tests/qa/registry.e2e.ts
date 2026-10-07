import { test, expect } from 'e2e';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
test('read-only deployed verb registry declares versioned app reads', { tags: ['registry'] }, async () => {
  const runner = process.env.CARR_QA_REGISTRY_RUNNER;
  if (!runner) throw new Error('Set CARR_QA_REGISTRY_RUNNER to the sanctioned external CARR wrapper for this read-only QA probe.');
  const { stdout } = await execute(runner, ['call', 'list-verbs', JSON.stringify({ names_only: true })], { timeout: 30_000, maxBuffer: 1_000_000 });
  const registry = z.object({ ok: z.boolean(), count: z.number().int(), verbs: z.array(z.object({ name: z.string(), write: z.boolean() })) }).parse(JSON.parse(stdout));
  expect(registry.ok).toBe(true);
  expect(registry.count).toBe(registry.verbs.length);
  for (const name of ['read-progress-board', 'lead-board', 'read-invoice-tracker']) {
    const verb = registry.verbs.find((entry: { name: string }) => entry.name === name);
    expect(verb?.write).toBe(false);
  }
});
