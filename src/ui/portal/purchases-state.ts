import type { Property } from './purchases-package';
export type PurchaseState = { query: string; selected: string | null; proposed: readonly string[] };
export type PurchaseEvent = { kind: 'select' | 'toggle'; id: string } | { kind: 'filter'; query: string } | { kind: 'close' | 'reset' };
export const initialPurchaseState: PurchaseState = { query: '', selected: null, proposed: [] };
export function visibleProperties(properties: readonly Property[], state: PurchaseState) {
  const query = state.query.trim().toLocaleLowerCase();
  return properties.filter(p => [p.number, p.address, p.city, p.status, p.role].join(' ').toLocaleLowerCase().includes(query));
}
export function purchaseTransition(properties: readonly Property[], state: PurchaseState, event: PurchaseEvent): PurchaseState {
  switch (event.kind) {
    case 'select': return visibleProperties(properties, state).some(p => p.id === event.id) ? { ...state, selected: event.id } : state;
    case 'close': return { ...state, selected: null };
    case 'filter': return { ...state, query: event.query, selected: null };
    case 'reset': return { ...state, query: '', selected: null };
    case 'toggle': {
      if (!properties.some(p => p.id === event.id && p.role === 'candidate')) return state;
      return { ...state, proposed: state.proposed.includes(event.id) ? state.proposed.filter(id => id !== event.id) : [...state.proposed, event.id] };
    }
  }
}
