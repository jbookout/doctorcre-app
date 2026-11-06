import type { Table } from './answer-block-model';

function field(value: string | number | boolean | null): string {
  let text = value === null ? '' : String(value);
  if (typeof value === 'string' && /^[\s\u0000-\u001f\u007f-\u009f]*[=+@-]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function answerTableCsv(table: Table, rows: Table['rows']): string {
  const header = table.columns.flatMap((column, index) =>
    ['value', 'is_null', 'source_type', 'record_id', 'fact_id', 'version'].map(part => `${column.label} [${index + 1}:${column.key}].${part}`));
  const records = rows.map(row => table.columns.flatMap(column => {
    const cell = row[column.key];
    if (!cell) throw new Error('Missing parsed table cell');
    const { value, source } = cell;
    return [value, value === null, source ? 'record_id' in source ? 'record' : 'fact' : '',
      source && 'record_id' in source ? source.record_id : '',
      source && 'fact_id' in source ? source.fact_id : '',
      source && 'version' in source ? source.version : ''];
  }));
  return [header, ...records].map(record => record.map(field).join(',')).join('\r\n') + '\r\n';
}

export function downloadAnswerTable(table: Table, rows: Table['rows']): void {
  if (!rows.length) return;
  const blob = new Blob([answerTableCsv(table, rows)], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  try {
    link.href = url;
    link.download = `answer-${table.id}.csv`;
    link.hidden = true;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
