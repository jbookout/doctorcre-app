type Source = { record_id: string } | { fact_id: string; version: number };
export type Cell = { value: string | boolean | null; source?: Source } | { value: number; source: Source };
type Column = { key: string; label: string; type: 'text' | 'number' | 'boolean' | 'date' };
export type Table = { type: 'table.v1'; id: string; columns: Column[]; rows: Record<string, Cell>[] };
export type Chart = { type: 'chart.v1'; id: string; table_id: string; kind: 'bar' | 'line'; x: string; y: string };
type Block = Table | Chart;
export type Answer = { kind: 'text' } | { kind: 'invalid' } | { kind: 'valid'; blocks: Block[] };
export type Sort = { key: string; direction: 'asc' | 'desc' } | null;

const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const keys = (x: Record<string, unknown>, allowed: string[]) => Object.keys(x).every(k => allowed.includes(k));
const id = (x: unknown): x is string => typeof x === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(x);
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
function isSource(x: unknown): x is Source {
  return object(x) && (keys(x, ['record_id']) && uuid(x.record_id)
    || keys(x, ['fact_id', 'version']) && uuid(x.fact_id) && typeof x.version === 'number' && Number.isSafeInteger(x.version) && x.version >= 1);
}
function isCell(x: unknown): x is Cell {
  if (!object(x) || !keys(x, ['value', 'source']) || !('value' in x) || ('source' in x && !isSource(x.source))) return false;
  return typeof x.value === 'number' ? Number.isFinite(x.value) && isSource(x.source)
    : x.value === null || typeof x.value === 'boolean' || typeof x.value === 'string' && [...x.value].length <= 2000;
}
function isColumn(x: unknown): x is Column {
  return object(x) && keys(x, ['key', 'label', 'type']) && id(x.key) && typeof x.label === 'string'
    && x.label.length > 0 && [...x.label].length <= 200 && ['text', 'number', 'boolean', 'date'].includes(String(x.type));
}
function isRow(x: unknown): x is Record<string, Cell> {
  return object(x) && Object.values(x).every(isCell);
}
function isBlock(x: unknown): x is Block {
  if (!object(x) || !id(x.id)) return false;
  if (x.type === 'chart.v1') return keys(x, ['type', 'id', 'table_id', 'kind', 'x', 'y'])
    && id(x.table_id) && id(x.x) && id(x.y) && (x.kind === 'bar' || x.kind === 'line');
  if (x.type !== 'table.v1' || !keys(x, ['type', 'id', 'columns', 'rows'])
    || !Array.isArray(x.columns) || !x.columns.every(isColumn) || !x.columns.length || x.columns.length > 20
    || !Array.isArray(x.rows) || x.rows.length > 200 || !x.rows.every(isRow)) return false;
  const columns = x.columns;
  if (new Set(columns.map(c => c.key)).size !== columns.length) return false;
  return x.rows.every(row => Object.keys(row).length === columns.length && columns.every(column => {
    const cell = row[column.key];
    if (!cell) return false;
    if (cell.value === null) return true;
    if (column.type === 'date') return typeof cell.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cell.value)
      && Number.isFinite(Date.parse(cell.value)) && new Date(cell.value).toISOString().slice(0, 10) === cell.value;
    return typeof cell.value === ({ text: 'string', number: 'number', boolean: 'boolean' })[column.type];
  }));
}

export function parseAnswerBlocks(input: unknown): Answer {
  if (input === undefined || Array.isArray(input) && input.length === 0) return { kind: 'text' };
  try {
    if (new TextEncoder().encode(JSON.stringify(input)).length > 131072 || !Array.isArray(input)
      || input.length > 8 || !input.every(isBlock) || new Set(input.map(b => b.id)).size !== input.length) return { kind: 'invalid' };
    const tables = new Map(input.filter(b => b.type === 'table.v1').map(t => [t.id, t]));
    for (const block of input) if (block.type === 'chart.v1') {
      const columns = tables.get(block.table_id)?.columns;
      if (block.x === block.y || !columns?.some(c => c.key === block.x) || !columns.some(c => c.key === block.y && c.type === 'number')) return { kind: 'invalid' };
    }
    return { kind: 'valid', blocks: input };
  } catch { return { kind: 'invalid' }; }
}

export const cellText = (cell: Cell | undefined) => cell?.value == null ? '—' : String(cell.value);
export function tableRows(table: Table, sort: Sort, filter: string): Table['rows'] {
  const rows = table.rows.filter(row => table.columns.some(c => cellText(row[c.key]).toLocaleLowerCase().includes(filter.toLocaleLowerCase())));
  if (!sort) return rows;
  return rows.sort((a, b) => {
    const x = a[sort.key]?.value ?? null, y = b[sort.key]?.value ?? null;
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sort.direction === 'asc' ? order : -order;
  });
}
