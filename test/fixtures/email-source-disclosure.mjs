import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';

const directory = new URL('./email-source-disclosure/', import.meta.url);
export const producerIdentity = JSON.parse(readFileSync(new URL('producer.json', directory)));
function load(name, dependencies = {}) {
  const source = readFileSync(new URL(name + '.txt', directory), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), producerIdentity.files[name], name + ' producer SHA-256');
  const module = { exports: {} };
  const code = source.replace(/^import .*?;\n/gms, '');
  new Function('module', ...Object.keys(dependencies), transformSync(code, { loader: name.endsWith('.ts') ? 'ts' : 'js', format: 'cjs' }).code)(module, ...Object.values(dependencies));
  return module.exports;
}
export async function replay(record) {
  const unused = () => { throw Error('Unexpected producer dependency'); };
  const { sha256 } = load('sha256.ts');
  const { isCalendarDate } = load('calendar-date.ts');
  const { ToolError } = load('tool-error.ts');
  const { suspected } = load('untrusted-text.js');
  const authority = load('partner-authority.js', { authorizationClassForActor: unused });
  const { emailNextStepTools } = load('email-next-step.ts', { sha256, isCalendarDate, ToolError, derivedIdempotencyKey: unused });
  const { emailProposalTools } = load('email-proposals.js', { sha256, suspected, ...authority, lockEmailIdentity: unused, capturedEmail: unused });
  const preview = emailNextStepTools({})['preview-email-next-step'].handler;
  const actor = { id: '40000000-0000-4000-8000-000000000001', slug: 'joe', human: true };
  const db = { async query(sql, args) {
    if (sql.includes('select p.id,p.version')) return { rows: record.rows };
    if (sql.includes('select d.id as deal_id')) return { rows: record.sources.filter(row => row.deal_id === args[0] && row.activity_id === args[1]) };
    throw Error('Unexpected producer query');
  } };
  if (record.verb === 'preview-email-next-step') return preview(db, actor, record.args);
  return emailProposalTools({ ToolError, preview: (c, a, verb, args) => {
    assert.equal(verb, 'preview-email-next-step'); return preview(c, a, args);
  } })['list-email-proposals'].handler(db, actor, record.args);
}
export function recordings() {
  return JSON.parse(readFileSync(new URL('recordings.json', directory)));
}
export async function checkedResponses(records = recordings()) {
  const result = {};
  for (const [name, record] of Object.entries(records)) {
    assert.deepEqual(await replay(record), record.response, name + ' equals pinned producer');
    result[name] = record.response;
  }
  return result;
}
