import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { validateQuietFollowUps } from '../../../js/leads-client.js';

export async function admitRecording() {
  const base = new URL('../quiet-lead-owner-pages/', import.meta.url);
  const source = await readFile(new URL('producer.txt', base), 'utf8');
  const provenance = JSON.parse(await readFile(new URL('provenance.json', base)));
  if (createHash('sha256').update(source).digest('hex') !== provenance.sha256) throw Error('Pinned producer changed');
  const start = source.indexOf('handler: async', source.indexOf("'quiet-follow-ups':"));
  const end = source.indexOf("\n    'territory-state-board':", start);
  const handler = source.slice(start + 'handler: '.length, end).replace(/,\n    },$/, '');
  const compiled = await transform(`const handler = ${handler}; globalThis.handler = handler;`, { loader: 'ts', target: 'es2022' });
  const context = { CONTACTABLE_STATES: ['active', 'nurture'], ToolError: Error };
  vm.runInNewContext(compiled.code, context);
  const recording = JSON.parse(await readFile(new URL('recordings.json', import.meta.url)));
  const response = await context.handler({ query: async () => ({ rows: recording.proposals }) }, null, {});
  validateQuietFollowUps(response);
  if (JSON.stringify(response) !== JSON.stringify(recording)) throw Error('Recording differs from registered handler response');
  return recording;
}
