export const publicationContract = { schema: 'client-publications.v1', revision: '541e47ffce83bbd6cb591545417be0dd91a3ea0c', owner: 'DoctorCRE/carr-system' };
export type Request = (name: string, args: object, options: {signal: AbortSignal}) => Promise<unknown>;
type TextKind = 'milestone' | 'document' | 'tour' | 'report';
export type Content = {kind: TextKind; content: string} | {kind: 'deliverable'; deliverable_id: string};
export type Publication = Content & {id: string; title: string; published: boolean; version: number};
export type Command = Content & {deal_id: string; publication_id: string; base_version: number; title: string; published: boolean; idempotency_key: string};
export type Visible = {kind: TextKind; title: string; content: string} | {kind: 'deliverable'; title: string; deliverable: {id: string; filename: string; mime: string; bytes: number}};
export type Portal = {slug: string; materials: Visible[]; publications: Visible[]};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const textKind = (v: unknown): v is TextKind => v === 'milestone' || v === 'document' || v === 'tour' || v === 'report';
export function envelope(value: unknown) {
  if (!record(value) || value.ok !== true || value.schema_version !== publicationContract.schema) throw Error('Invalid publication response');
  return value;
}
export function parsePublications(value: unknown): Publication[] {
  const rows = envelope(value).publications;
  if (!Array.isArray(rows) || rows.length > 1000) throw Error('Invalid publications');
  return rows.map(row => {
    if (!record(row) || !uuid(row.id) || !text(row.title,200) || typeof row.published !== 'boolean' || typeof row.version !== 'number' || !Number.isInteger(row.version) || row.version < 1) throw Error('Invalid publication');
    const common = {id: row.id,title: row.title,published: row.published,version: row.version};
    if (row.kind === 'deliverable' && uuid(row.deliverable_id)) return {...common,kind:'deliverable',deliverable_id:row.deliverable_id};
    if (textKind(row.kind) && text(row.content,10000)) return {...common,kind:row.kind,content:row.content};
    throw Error('Invalid publication content');
  });
}
function visible(value: unknown): Visible {
  if (!record(value) || !text(value.title,200)) throw Error('Invalid preview');
  if (textKind(value.kind) && text(value.content,10000)) return {kind:value.kind,title:value.title,content:value.content};
  const f = value.deliverable;
  if (value.kind === 'deliverable' && record(f) && uuid(f.id) && text(f.filename,1000) && text(f.mime,200) && typeof f.bytes === 'number' && Number.isSafeInteger(f.bytes) && f.bytes >= 0) return {kind:'deliverable',title:value.title,deliverable:{id:f.id,filename:f.filename,mime:f.mime,bytes:f.bytes}};
  throw Error('Invalid preview content');
}
export function parsePortal(value: unknown): Portal | null {
  const p = envelope(value).portal;
  if (p === null) return null;
  if (!record(p) || !text(p.slug,63) || !Array.isArray(p.materials) || p.materials.length > 100 || !Array.isArray(p.publications) || p.publications.length > 100) throw Error('Invalid portal');
  return {slug:p.slug,materials:p.materials.map(visible),publications:p.publications.map(visible)};
}
export function commandFor(row: Publication, deal_id: string, published: boolean): Command {
  const common = {deal_id,publication_id:row.id,base_version:row.version,title:row.title,published,idempotency_key:crypto.randomUUID()};
  return row.kind === 'deliverable' ? {...common,kind:row.kind,deliverable_id:row.deliverable_id} : {...common,kind:row.kind,content:row.content};
}
