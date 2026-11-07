import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

type OwnerNode = { owner?: string | null };
export function relationshipOwnerValue(owner: OwnerNode['owner']): string {
  return JSON.stringify([owner?.trim() ? owner : null]);
}
export function mountRelationshipOwnerFilter(host: HTMLElement, { value, onChange }: {
  value: string; onChange: (owner: string) => void;
}) {
  const root = createRoot(host);
  let disposed = false;
  let options: { value: string; label: string }[] = [];
  let selected = value;
  function render() {
    if (disposed) return;
    flushSync(() => root.render(<>
      <label htmlFor="networkOwner">Recorded owner</label>
      <select id="networkOwner" value={selected} disabled={!options.length} onChange={event => {
        selected = event.currentTarget.value;
        render();
        onChange(selected);
      }}>
        <option value="">All owners</option>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </>));
  }
  render();
  return {
    update(nodes: OwnerNode[] | null, value: string) {
      options = [...new Set((nodes || []).map(node => node.owner).filter(owner => owner?.trim()))]
        .sort().map(owner => ({ value: relationshipOwnerValue(owner), label: `Recorded owner: ${owner}` }));
      if (nodes?.some(node => !node.owner?.trim())) options.push({ value: relationshipOwnerValue(null), label: 'Owner not recorded' });
      selected = nodes && !options.some(option => option.value === value) ? '' : value;
      render();
      return selected;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      flushSync(() => root.unmount());
    },
  };
}
