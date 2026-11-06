import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { cellText, parseAnswerBlocks, tableRows } from './answer-block-model';
import type { Answer, Cell, Chart, Sort, Table } from './answer-block-model';

function SourcedCell({cell}: {cell: Cell | undefined}) {
  return <>{cellText(cell)}{cell?.source && <details className="answer-source"><summary>Source</summary><span>{'record_id' in cell.source
    ? `Record ${cell.source.record_id}` : `Fact ${cell.source.fact_id}, version ${cell.source.version}`}</span></details>}</>;
}
function AnswerTable({table}: {table: Table}) {
  const [sort, setSort] = useState<Sort>(null);
  const [filter, setFilter] = useState('');
  const rows = tableRows(table, sort, filter);
  return <section className="answer-table" aria-label={`Answer table ${table.id}`}>
    <label>Filter rows <input type="search" value={filter} onChange={e => setFilter(e.target.value)} /></label>
    <button type="button" onClick={() => {setSort(null); setFilter('');}}>Reset table</button>
    <p role="status">{rows.length} of {table.rows.length} rows</p>
    {rows.length === 0 && <p>{table.rows.length === 0
      ? 'No recorded rows in this answer'
      : <>No loaded rows match this filter <button type="button" onClick={() => setFilter('')}>Clear filter</button></>}</p>}
    <div className="answer-scroll" tabIndex={0} role="region" aria-label="Scrollable answer table">
      <table><caption>{table.id === 'comps' ? 'Recorded proposed negotiation rents' : `Recorded answer data: ${table.id}`}</caption>
        <thead><tr>{table.columns.map(column => <th key={column.key} scope="col" aria-sort={sort?.key === column.key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
          <button type="button" onClick={() => setSort({key:column.key,direction:sort?.key === column.key && sort.direction === 'asc' ? 'desc' : 'asc'})}>{column.label}</button>
        </th>)}</tr></thead>
        <tbody>{rows.map((row, i) => <tr key={i}>{table.columns.map(column => <td key={column.key}><SourcedCell cell={row[column.key]} /></td>)}</tr>)}</tbody>
      </table>
    </div>
  </section>;
}
function AnswerChart({chart, table}: {chart: Chart; table: Table}) {
  const [active, setActive] = useState<string | null>(null);
  const points = table.rows.flatMap((row, index) => {
    const value = row[chart.y]?.value;
    return typeof value === 'number' ? [{index, value, label:cellText(row[chart.x])}] : [];
  });
  const scale = Math.max(1, ...points.map(p => Math.abs(p.value)));
  const min = Math.min(0, ...points.map(p => p.value / scale)), max = Math.max(0, ...points.map(p => p.value / scale));
  const y = (value: number) => 180 - (value / scale - min) / (max - min || 1) * 160;
  const x = (index: number) => 30 + index * 540 / Math.max(1, table.rows.length);
  const width = Math.max(1, 440 / Math.max(1, table.rows.length));
  const segments: typeof points[] = [];
  for (const point of points) {
    const segment = segments.at(-1);
    if (segment?.at(-1)?.index === point.index - 1) segment.push(point);
    else segments.push([point]);
  }
  const label = `${table.columns.find(c => c.key === chart.y)?.label ?? chart.y} by ${table.columns.find(c => c.key === chart.x)?.label ?? chart.x}`;
  return <figure className="answer-chart"><figcaption>{label}. Full values and sources are in table {table.id}.</figcaption>
    <svg viewBox="0 0 600 210" role="group" aria-label={label}>
      <line x1="20" x2="580" y1={y(0)} y2={y(0)} stroke="currentColor" />
      {chart.kind === 'line' && segments.map((segment, index) => <polyline key={index} fill="none" stroke="currentColor" points={segment.map(p => `${x(p.index)},${y(p.value)}`).join(' ')} />)}
      {points.map(p => {
        const text = `${p.label}: ${p.value}`;
        const handlers = {tabIndex:0,role:'img','aria-label':text,onFocus:() => setActive(text),onBlur:() => setActive(null),onMouseEnter:() => setActive(text),onMouseLeave:() => setActive(null)};
        return chart.kind === 'bar' ? <rect key={p.index} {...handlers} x={x(p.index)} y={Math.min(y(0),y(p.value))} width={width} height={Math.max(1,Math.abs(y(0)-y(p.value)))} fill="currentColor"><title>{text}</title></rect>
          : <circle key={p.index} {...handlers} cx={x(p.index)} cy={y(p.value)} r="4" fill="currentColor"><title>{text}</title></circle>;
      })}
    </svg><p role="status">{active ?? 'Focus or hover a value to inspect it.'}</p>
  </figure>;
}
function AnswerBlocks({answer}: {answer: Answer}) {
  if (answer.kind === 'invalid') return <p role="status">Interactive answer unavailable</p>;
  if (answer.kind === 'text') return null;
  return <>{answer.blocks.map(block => {
    if (block.type === 'table.v1') return <AnswerTable key={JSON.stringify(block)} table={block} />;
    const table = answer.blocks.find((b): b is Table => b.type === 'table.v1' && b.id === block.table_id);
    return table ? <AnswerChart key={JSON.stringify([block,table])} chart={block} table={table} /> : null;
  })}</>;
}

const mounts = new WeakMap<HTMLElement, {root: Root; fingerprint: string}>();
export function mountAnswerBlocks(host: HTMLElement, blocks: unknown, identity: string): void {
  const fingerprint = JSON.stringify([identity,blocks]);
  const mounted = mounts.get(host);
  if (mounted?.fingerprint === fingerprint) return;
  const root = mounted?.root ?? createRoot(host);
  root.render(<AnswerBlocks key={identity} answer={parseAnswerBlocks(blocks)} />);
  mounts.set(host, {root, fingerprint});
}
export function disposeAnswerBlocks(host: HTMLElement): void {
  mounts.get(host)?.root.unmount();
  mounts.delete(host);
}
