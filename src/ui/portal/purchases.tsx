import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Asset, Property, PurchasePackage } from './purchases-package';
import { initialPurchaseState, purchaseTransition, visibleProperties } from './purchases-state';
import type { PurchaseEvent } from './purchases-state';
import { PurchaseMap } from './purchases-map';

export type PurchaseProposal = { propertyId: string; selected: boolean };
function assetUrl(asset: Asset | undefined, kind: 'photo' | 'plan') {
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256)) return undefined;
  const allowed = kind === 'photo' ? ['image/jpeg', 'image/png', 'image/webp'] : ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  return allowed.includes(asset.type) ? `files/${asset.sha256}` : undefined;
}
function Photo({ property }: { property: Property }) {
  const [failed, setFailed] = useState(false);
  const url = assetUrl(property.photo, 'photo');
  return url && !failed ? <img loading="lazy" src={url} alt={`Property at ${property.address}`} onError={() => setFailed(true)} /> : <p>Property photo unavailable.</p>;
}
function SourceLinks({ property }: { property: Property }) {
  return <ul>{property.sources.map((source, index) => {
    let url: URL | undefined;
    try { const parsed = new URL(source.url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed; } catch {}
    return <li key={index}>{url ? <a href={url.href} target="_blank" rel="noopener noreferrer">{source.label}</a> : <span>{source.label}</span>}{source.date && ` · ${source.date}`}</li>;
  })}</ul>;
}
function PropertyDialog({ property, proposed, contextNote, close, toggle }: {
  property: Property; proposed: boolean; contextNote: string | undefined; close: () => void; toggle: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const plan = assetUrl(property.floorplan, 'plan');
  return <dialog ref={dialog} id="property-dialog" className="purchase-dialog" data-property-id={property.id} aria-labelledby="purchase-dialog-title"
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }}>
    <button id="property-dialog-close" type="button" onClick={close} autoFocus>Close property</button>
    <h2 id="purchase-dialog-title">{property.number}. {property.address}</h2><p>{property.city} · {property.status}</p>
    {property.role === 'market-context' && <p><strong>Market context. Excluded from the shortlist.</strong> {contextNote}</p>}
    <Photo key={property.id} property={property} /><p>{property.source_caption}</p>
    <dl>{property.facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
    <h3>Property review</h3><p>{property.summary}</p>
    {property.review_point && <><h3>First question to resolve</h3><p>{property.review_point}</p></>}
    {property.notes && Object.entries(property.notes).map(([key, note]) => <p key={key}>{note}</p>)}
    <p>Confirm condition, availability and suitability during a walkthrough with the listing broker.</p>
    {plan && <p className="property-links"><a href={plan} target="_blank" rel="noopener noreferrer">View supplied floor plan</a></p>}
    <SourceLinks property={property} /><p><a className="carr-link" href="#sources" onClick={close}>View primary source</a></p>
    {property.role === 'candidate' && <button type="button" data-toggle={property.id} aria-pressed={proposed} onClick={toggle}>{proposed ? 'Remove from Tour List proposal' : 'Add to Tour List proposal'}</button>}
  </dialog>;
}
const styles = `
.purchases{background:var(--surface-1,#fff);color:var(--text-1,#20282b);max-width:1200px;margin:auto;padding:1rem;font-family:var(--font-body,Arial,sans-serif)}
.purchases *{box-sizing:border-box}.purchases button,.purchases input,.purchases a{font:inherit}
.purchases button,.purchases input{min-height:44px;max-width:100%;padding:.65rem;border:1px solid var(--hairline-strong,#8a979d);border-radius:.4rem;background:var(--surface-1,#fff);color:inherit}
.purchases button{cursor:pointer}.purchases :focus-visible{outline:3px solid var(--accent,#237d83);outline-offset:3px}
.purchase-factors,.purchase-directory{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,270px),1fr));gap:1rem;margin-block:1rem}
.purchase-factors article,.purchase-directory article{padding:1rem;border:1px solid var(--hairline-strong,#8a979d);border-radius:.7rem;background:var(--surface-1,#fff)}
.purchase-directory article[data-selected=true]{outline:3px solid var(--accent,#237d83)}
.purchase-directory img,.purchase-dialog img{width:100%;max-height:320px;object-fit:cover;border-radius:.4rem}
.purchases dl{display:flex;gap:1rem;flex-wrap:wrap}.purchases dd{margin:0;font-weight:600}
.purchase-table{overflow:auto}.purchase-table table{border-collapse:collapse;width:100%}.purchase-table th,.purchase-table td{text-align:left;padding:.6rem;border-bottom:1px solid var(--hairline-strong,#8a979d)}
.purchase-dialog{max-width:min(680px,calc(100vw - 2rem));max-height:85vh;overflow:auto;color:var(--text-1,#20282b);background:var(--surface-1,#fff);border:1px solid var(--hairline-strong,#8a979d);border-radius:.7rem;padding:1rem}
.purchase-dialog::backdrop{background:#0008}.purchase-dialog a,.purchases a{color:var(--accent,#17676f);overflow-wrap:anywhere}
.purchase-map{margin:1rem 0}.purchase-map-canvas{height:380px;border:1px solid var(--hairline-strong,#8a979d);border-radius:.7rem;position:relative;overflow:hidden}
.purchase-map-canvas .maplibregl-marker{position:absolute;top:0;left:0}.purchase-map-canvas canvas{display:block}.purchase-pin{font-weight:700}.purchase-pin[aria-pressed=true],.purchase-pin[data-active=true]{outline:3px solid var(--accent,#237d83)}
.purchase-preview{display:none;position:absolute;bottom:100%;left:0;min-width:150px;padding:.5rem;background:var(--surface-1,#fff);color:var(--text-1,#20282b);border:1px solid;pointer-events:none}
.purchase-pin:hover .purchase-preview,.purchase-pin:focus .purchase-preview{display:block}
[data-theme=dark] .purchases,[data-theme=dark] .purchase-dialog{--text-1:#edf0f1;--surface-1:#172126;--hairline-strong:#65767f;--accent:#86d7d3}
`;
export function Purchases({ publication, onProposal }: { publication: PurchasePackage; onProposal?: (proposal: PurchaseProposal) => void }) {
  return <PurchaseDirectory key={JSON.stringify(publication)} publication={publication} {...(onProposal ? { onProposal } : {})} />;
}
function PurchaseDirectory({ publication, onProposal }: { publication: PurchasePackage; onProposal?: (proposal: PurchaseProposal) => void }) {
  const [state, dispatch] = useReducer((state: typeof initialPurchaseState, event: PurchaseEvent) => purchaseTransition(publication.properties, state, event), initialPurchaseState);
  const [active, setActive] = useState<string | null>(null);
  const visible = useMemo(() => visibleProperties(publication.properties, state), [publication, state.query]);
  const property = publication.properties.find(p => p.id === state.selected);
  const ids = publication.properties.map(p => p.id);
  const contextId = publication.properties.find(p => p.role === 'market-context')?.id;
  if (new Set(ids).size !== ids.length) return <p role="alert">Properties unavailable. This publication contains duplicate property IDs.</p>;
  if (!publication.properties.length || !publication.purchases) return null;
  const toggle = (item: Property) => {
    if (item.role !== 'candidate') return;
    const selected = !state.proposed.includes(item.id);
    dispatch({ kind: 'toggle', id: item.id });
    onProposal?.({ propertyId: item.id, selected });
  };
  return <section id="purchases" className="purchases" aria-label="Purchases"><style>{styles}</style>
    <div className="selection-intro"><p>{publication.purchases.intro}</p><div className="purchase-factors">{publication.purchases.screening_factors.map((factor, index) => <article key={index}><h2>{factor.title}</h2><p>{factor.body}</p></article>)}</div></div>
    <h2>Properties at a glance</h2>
    <label>Filter properties <input value={state.query} onChange={event => dispatch({ kind: 'filter', query: event.target.value })} /></label>{' '}
    <button type="button" onClick={() => dispatch({ kind: 'reset' })}>Reset filters</button>
    <p role="status">{visible.length} properties · {state.proposed.length} in your Tour List proposal</p>
    <PurchaseMap publication={publication} properties={visible} selected={state.selected} active={active} select={id => dispatch({ kind: 'select', id })} />
    {publication.purchases.table && <><p>{publication.purchases.table.locator_note}</p><div className="purchase-table table-wrap"><table id="purchase-table"><caption>Property comparison</caption><thead><tr><th>Option</th><th>Property</th><th>Status</th><th>Listing facts</th></tr></thead><tbody>{visible.map(item => <tr key={item.id} data-property-id={item.id} aria-selected={state.selected === item.id}><td>{item.number}</td><td><button type="button" onClick={() => dispatch({ kind: 'select', id: item.id })}>{item.address}</button>{item.role === 'market-context' && ' · Market context, excluded'}</td><td>{item.status}</td><td>{item.facts.map(f => `${f.label}: ${f.value}`).join(' · ')}{item.review_point && <p>{item.review_point}</p>}</td></tr>)}</tbody></table></div><p>{publication.purchases.table.parking_note}</p></>}
    <h2>Choose a property</h2>{!visible.length && <p>No properties match. Reset filters to see the directory.</p>}
    <div id="property-directory" className="purchase-directory">{visible.map(item => <article className="property-jump" key={item.id} data-property-id={item.id} data-selected={state.selected === item.id} onMouseEnter={() => setActive(item.id)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(item.id)} onBlur={() => setActive(null)}>
      <Photo property={item} /><h3>{item.number}. {item.address}</h3><p>{item.city} · {item.status}</p><p>{item.summary}</p>{item.review_point && <p>{item.review_point}</p>}
      {item.role === 'market-context' && <p id={item.id === contextId ? 'market-context' : undefined}><strong>Market context. Excluded from the shortlist.</strong> {publication.purchases.market_context_note}</p>}
      <button id={item.id === contextId ? 'market-context-open' : undefined} type="button" onClick={() => dispatch({ kind: 'select', id: item.id })}>View {item.number}. {item.address}</button>
    </article>)}</div>
    <p>Tour List selections are proposals for partner review, not appointments or changes to CARR.</p><div className="purchase-tour-cta"><a href="#tour-list">Start Tour List</a></div>
    {property && <PropertyDialog key={property.id} property={property} proposed={state.proposed.includes(property.id)} contextNote={publication.purchases.market_context_note} close={() => dispatch({ kind: 'close' })} toggle={() => toggle(property)} />}
  </section>;
}
export const purchasesModule = {
  route: 'purchases', label: 'Purchases',
  available: (publication: PurchasePackage) => Boolean(publication.purchases && publication.properties.length),
  render: (publication: PurchasePackage) => <Purchases publication={publication} />,
} satisfies { route: 'purchases'; label: string; available: (publication: PurchasePackage) => boolean; render: (publication: PurchasePackage) => React.ReactNode };
