import { Component, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Asset, Competition, CountShare, MicroZone, MicroZones, Rich } from './microzones-competition-data';

export type Office = Competition['offices'][number];
export type AnalyticalMapData = { kind: 'zone'; zone: MicroZone; zones: readonly MicroZone[]; selectZone: (id: string) => void } | { kind: 'competition'; offices: readonly Office[]; selectedIdentity: string | undefined; previewOffice: (identity: string) => void };
type Props = { microZones?: MicroZones | undefined; competition?: Competition | undefined; renderMap?: ((data: AnalyticalMapData) => ReactNode) | undefined };
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const fmt = (value: number | undefined) => value === undefined ? 'Not reported' : number.format(value);
const assetPath = (asset: Asset) => `files/${asset.sha256}`;
export const officeIdentity = (office: Office) => JSON.stringify([office.name, office.address, office.source_url]);

function ExternalLink({ url, children }: { url: string; children: ReactNode }) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return <a href={url} target="_blank" rel="noopener noreferrer">{children}</a>;
  } catch {}
  return <span>{children} (source unavailable)</span>;
}
function TextRuns({ runs }: { runs: Rich }) {
  return <>{runs.map((run, i) => 'text' in run ? <span key={i}>{run.text} </span> : <ExternalLink key={i} url={run.link.url}>{run.link.label}</ExternalLink>)}</>;
}
class MapBoundary extends Component<{ children: ReactNode; recoveryKey: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: { recoveryKey: string }) {
    if (this.state.failed && previous.recoveryKey !== this.props.recoveryKey) this.setState({ failed: false });
  }
  render() { return this.state.failed ? <p role="status">Map unavailable. The report and directory remain available.</p> : this.props.children; }
}
function MapContent({ renderMap, data }: { renderMap: Props['renderMap']; data: AnalyticalMapData }) {
  return renderMap ? renderMap(data) : <p>Map unavailable. Use the report and directory below.</p>;
}
function PageLink({ zone, page }: { zone: MicroZone; page: number }) {
  return <a className="zone-source" href={`${assetPath(zone.study_pdf)}#page=${page}`} target="_blank" rel="noopener noreferrer">{zone.name} report, page {page}</a>;
}
function Values({ rows }: { rows: readonly (readonly [string, number | undefined, string?])[] }) {
  return <dl className="zone-values">{rows.map(([label, value, unit]) => <div key={label}><dt>{label}</dt><dd>{fmt(value)}{unit ? ` ${unit}` : ''}</dd></div>)}</dl>;
}
function Shares({ rows, denominator }: { rows: readonly CountShare[]; denominator: string }) {
  return <div className="zone-table" tabIndex={0} role="region" aria-label={denominator}><table><caption>{denominator}</caption><thead><tr><th scope="col">Category</th><th scope="col">Count</th><th scope="col">Reported %</th><th scope="col">Derived %</th></tr></thead><tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td>{fmt(row.count)}</td><td>{fmt(row.reported_percent)}</td><td>{fmt(row.derived_percent)}</td></tr>)}</tbody></table></div>;
}
function PracticeDialog({ office, close }: { office: Office; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (opener instanceof HTMLElement) opener.focus(); };
  }, []);
  return <dialog id="provider-dialog" ref={dialog} aria-label={office.name} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div><button id="provider-dialog-close" type="button" onClick={close} aria-label="Close practice details">Close</button>
      <h2>{office.name}</h2><img src={assetPath(office.logo)} alt="" width="80" height="60" onError={event => { event.currentTarget.hidden = true; }} />
      <p>{office.address}</p><p>{office.market}. {office.service_type}.</p><ul>{office.services.map(service => <li key={service}>{service}</li>)}</ul>
      <ExternalLink url={office.source_url}>Primary practice website</ExternalLink>
    </div>
  </dialog>;
}
function ZoneProfile({ zone, data }: { zone: MicroZone; data: MicroZones }) {
  const [topic, setTopic] = useState<'Population' | 'Age' | 'Income'>('Population');
  const rows = topic === 'Population' ? data.years.map(year => ({ label: year.label, value: zone.population.by_year[String(year.year)] }))
    : topic === 'Age' ? zone.age.groups.map(row => ({ label: row.label, value: row.count }))
    : zone.household_income.thresholds.map(row => ({ label: `$${fmt(row.minimum_usd)} or more`, value: row.count }));
  const max = Math.max(1, ...rows.map(row => row.value ?? 0));
  return <section><div role="group" aria-label="Micro-zone topic" className="demo-switch optional-switch">{(['Population', 'Age', 'Income'] satisfies ('Population' | 'Age' | 'Income')[]).map(name => <button type="button" key={name} aria-pressed={topic === name} onClick={() => setTopic(name)}>{name} profile</button>)}</div>
    <div id="micro-zone-profile"><h3>{topic} profile</h3><p>{topic === 'Population' ? 'Population by year' : `${data.estimate_year} counts`}</p>
      {rows.map(row => <div key={row.label} className="zone-profile-row"><span>{row.label}</span><strong>{fmt(row.value)}</strong><span className="zone-profile-bar" aria-hidden="true" style={{ width: `${(row.value ?? 0) / max * 100}%` }} /></div>)}
      <PageLink zone={zone} page={topic === 'Population' ? zone.population.source_page : topic === 'Age' ? zone.age.source_page : zone.household_income.source_page} />
    </div>
  </section>;
}
function ZoneReport({ zone: z, data }: { zone: MicroZone; data: MicroZones }) {
  const estimate = data.estimate_year;
  const projection = data.projection_year;
  const yearRows = (values: Readonly<Record<string, number>>) => data.years.map(year => [year.label, values[String(year.year)]] satisfies readonly [string, number | undefined]);
  return <article data-zone-id={z.id}>
    <h3>{z.name}</h3>
    <p>{z.geography.radius_miles}-mile radius around {z.geography.center_address}. Reported area {fmt(z.geography.reported_area_sq_miles)} square miles.</p>
    <p>Center {z.geography.center.join(', ')}. {z.geography.center_precision}. {z.geography.allocation_method}.</p>
    <p>{z.source.provider}. Report timestamp {z.source.report_timestamp}, {z.source.report_timezone ?? 'timezone not stated'}. {z.source.pages} pages. {z.source.data_release}. {z.source.geography_version}.</p>
    <p>Estimate year {estimate}. Projection year {projection}. {z.geography.source_pages.map(page => <span key={page}><PageLink zone={z} page={page} />{' '}</span>)}</p>
    <section><h4>Population</h4><Values rows={yearRows(z.population.by_year)} />
      <Values rows={[
        ['Density per square mile', z.population.density_per_sq_mile], ['Growth, persons', z.population.growth.persons],
        ['Growth percent', z.population.growth.percent, '%'], ['Reported annual growth', z.population.growth.reported_annual_percent, '%'],
      ]} /><p>{estimate} to {projection}. {z.population.growth.percent_method}. {z.population.growth.annual_percent_method}.</p><PageLink zone={z} page={z.population.source_page} /></section>
    <section><h4>Households</h4><Values rows={yearRows(z.households.by_year)} /><Values rows={[
      ['With children', z.households.with_children.count], ['With children, reported share of households', z.households.with_children.reported_percent, '%'], ['Average household size', z.households.average_size],
    ]} /><p>{estimate} household denominator {fmt(z.households.by_year[String(estimate)])}.</p><PageLink zone={z} page={z.households.source_page} /></section>
    <section><h4>Income</h4>{([
      ['Average household income', z.income.average_household], ['Median household income', z.income.median_household], ['Per capita income', z.income.per_capita],
    ] satisfies readonly (readonly [string, Readonly<Record<string, number>>])[]).map(([label, values]) => <div key={label}><h5>{label}, USD</h5><Values rows={yearRows(values)} /></div>)}
      <Values rows={[
        ['Average family income, USD', z.income.average_family], ['Median family income, USD', z.income.median_family], ['Average household net worth, USD', z.income.average_household_net_worth],
      ]} /><PageLink zone={z} page={z.income.source_page} />
      <Shares rows={z.household_income.bins} denominator={`${estimate} household income, denominator ${fmt(z.household_income.denominator_households)} households`} />
      <Shares rows={z.household_income.thresholds.map(row => ({ ...row, label: `$${fmt(row.minimum_usd)} or more` }))} denominator="Income thresholds" />
      {z.household_income.thresholds.map(row => <p key={row.minimum_usd}>${fmt(row.minimum_usd)} or more. {row.method}.</p>)}<PageLink zone={z} page={z.household_income.source_page} /></section>
    <section><h4>Age</h4><p>{estimate} median age {fmt(z.age.median_years)} years.</p><Shares rows={z.age.bins} denominator={`Age bins, denominator ${fmt(z.age.denominator_population)} people`} /><Shares rows={z.age.groups} denominator={`Age groups, denominator ${fmt(z.age.denominator_population)} people`} /><PageLink zone={z} page={z.age.source_page} /></section>
    <section><h4>Housing</h4><p>{estimate}. Occupied and vacant shares use all {fmt(z.housing.total_units)} units. Owner and renter reported shares use {fmt(z.housing.occupied_units)} occupied units.</p><Values rows={[
      ['Total units', z.housing.total_units], ['Occupied units', z.housing.occupied_units], ['Occupied percent of all units', z.housing.occupied_percent_of_all_units, '%'],
      ['Owner occupied units', z.housing.owner_occupied_units], ['Owner occupied reported share of occupied units', z.housing.owner_occupied_reported_percent_of_occupied, '%'],
      ['Renter occupied units', z.housing.renter_occupied_units], ['Renter occupied reported share of occupied units', z.housing.renter_occupied_reported_percent_of_occupied, '%'],
      ['Vacant units', z.housing.vacant_units], ['Vacant percent of all units', z.housing.vacant_percent_of_all_units, '%'], ['Family households', z.housing.family_households], ['Non-family households', z.housing.non_family_households],
    ]} /><PageLink zone={z} page={z.housing.source_page} /></section>
    <section><h4>Education</h4><Shares rows={z.education.bins} denominator={`${estimate} ${z.education.denominator_label}, denominator ${fmt(z.education.denominator_count)}`} /><Values rows={[
      ["Bachelor's or higher count", z.education.bachelors_or_higher_count], ["Bachelor's or higher derived share", z.education.bachelors_or_higher_derived_percent, '%'],
    ]} /><PageLink zone={z} page={z.education.source_page} /></section>
    <section><h4>Employment</h4><p>{estimate}. Occupation denominator {fmt(z.employment.occupation_denominator)}.</p><Values rows={[
      ['Population age 16 plus', z.employment.population_age_16_plus], ['Employed', z.employment.employed], ['Unemployed', z.employment.unemployed], ['Armed forces', z.employment.armed_forces], ['Not in labor force', z.employment.not_in_labor_force], ['White collar', z.employment.white_collar], ['Blue collar', z.employment.blue_collar],
    ]} /><PageLink zone={z} page={z.employment.labor_source_page} /><Values rows={[
      ['Businesses', z.employment.businesses], ['Daytime employees', z.employment.daytime_employees],
    ]} /><PageLink zone={z} page={z.employment.business_source_page} /></section>
    <section><h4>Home values and commute</h4><p>{estimate}.</p><Values rows={[
      ['Median owner home value, USD', z.home_values_and_commute.median_owner_home_value], ['Median renter rent, USD', z.home_values_and_commute.median_renter_rent], ['Mean commute', z.home_values_and_commute.mean_commute_minutes, 'minutes'],
    ]} /><PageLink zone={z} page={z.home_values_and_commute.source_page} /></section>
  </article>;
}
export function MicrozonesCompetition({ microZones, competition, renderMap }: Props) {
  const [zoneId, setZoneId] = useState('');
  const [marketName, setMarketName] = useState<string | null>(null);
  const [officeSelection, setOfficeSelection] = useState<{ kind: 'preview' | 'details'; identity: string } | null>(null);
  const zone = microZones?.zones.find(row => row.id === zoneId) ?? microZones?.zones[0];
  const market = marketName !== null && competition?.markets.includes(marketName) ? marketName : null;
  const offices = competition?.offices.filter(office => market === null || office.market === market) ?? [];
  const counts = new Map<string, number>();
  for (const office of competition?.offices ?? []) counts.set(office.market, (counts.get(office.market) ?? 0) + 1);
  const selectedOffice = offices.find(office => officeIdentity(office) === officeSelection?.identity);
  if (!microZones && !competition) return null;
  return <div className="microzones-competition">
    {microZones && zone && <section id="micro-zone-context" aria-label="Micro-zone comparison">
      <h2>{microZones.title}</h2><p>{microZones.description}</p><p>{microZones.comparison_note}</p>
      <div id="micro-zone-switch" role="group" aria-label="Study zone" className="optional-switch">{microZones.zones.map(row => <button key={row.id} type="button" aria-pressed={zone.id === row.id} onClick={() => setZoneId(row.id)}>{row.name}</button>)}</div>
      <div id="micro-zone-map"><MapBoundary recoveryKey={JSON.stringify(zone)}><MapContent renderMap={renderMap} data={{ kind: 'zone', zone, zones: microZones.zones, selectZone: setZoneId }} /></MapBoundary></div>
      <div id="micro-zone-summary"><a href={assetPath(zone.study_pdf)} target="_blank" rel="noopener noreferrer">View {zone.name} study PDF</a></div>
      <ZoneProfile zone={zone} data={microZones} />
      <ZoneReport zone={zone} data={microZones} />
    </section>}
    {competition && <section id="competition" aria-label="Competitor directory"><h2>Competitor directory</h2><p><TextRuns runs={competition.scope_note} /></p>
      <p>Pins are approximate analytical locators. They do not establish capacity, service overlap or market saturation.</p>
      <a href="#sources">Competition scope and sources</a>
      <dl className="zone-values">{competition.markets.map(name => <div key={name}><dt>{name}</dt><dd>{counts.get(name) ?? 0} offices</dd></div>)}</dl>
      <label>Competition market <select value={market === null ? '' : JSON.stringify(market)} onChange={event => setMarketName(competition.markets.find(name => JSON.stringify(name) === event.target.value) ?? null)}>
        <option value="">All markets</option>{competition.markets.map(name => <option key={name} value={JSON.stringify(name)}>{name}</option>)}
      </select></label>
      <p role="status">{offices.length} {offices.length === 1 ? 'office' : 'offices'}{market === null ? ' across all markets' : ` in ${market}`}.</p>
      <div id="competition-map"><MapBoundary recoveryKey={JSON.stringify(offices)}><MapContent renderMap={renderMap} data={{ kind: 'competition', offices, selectedIdentity: selectedOffice ? officeIdentity(selectedOffice) : undefined, previewOffice: identity => setOfficeSelection({ kind: 'preview', identity }) }} /></MapBoundary></div>
      {selectedOffice && officeSelection?.kind === 'preview' && <aside id="property-preview" aria-label="Practice preview"><img src={assetPath(selectedOffice.logo)} alt="" width="80" height="60" onError={event => { event.currentTarget.hidden = true; }} /><p>{selectedOffice.name}</p><button type="button" onClick={() => setOfficeSelection(null)}>Close practice preview</button><button type="button" onClick={() => setOfficeSelection({ kind: 'details', identity: officeIdentity(selectedOffice) })}>View Practice Details</button></aside>}
      {offices.length === 0 ? <p>No offices in this package for {market ?? 'these markets'}.</p> : <ul id="competition-offices" className="competition-offices">{offices.map(office => <li key={officeIdentity(office)} data-office-id={officeIdentity(office)} data-selected={officeSelection?.identity === officeIdentity(office)} onMouseEnter={() => { if (officeSelection?.kind !== 'details') setOfficeSelection({ kind: 'preview', identity: officeIdentity(office) }); }}>
        <img src={assetPath(office.logo)} alt="" width="80" height="60" onError={event => { event.currentTarget.hidden = true; }} />
        <h3>{office.name}</h3><button type="button" onClick={() => setOfficeSelection({ kind: 'details', identity: officeIdentity(office) })}>View {office.name} details</button><p>{office.address}</p><p>{office.market}. {office.service_type}.</p><ul>{office.services.map(service => <li key={service}>{service}</li>)}</ul>
        <p>{office.locator.lon}, {office.locator.lat}. {office.locator.precision}.</p><ExternalLink url={office.source_url}>Visit {office.name} website</ExternalLink>
      </li>)}</ul>}
      {selectedOffice && officeSelection?.kind === 'details' && <PracticeDialog office={selectedOffice} close={() => setOfficeSelection(null)} />}
    </section>}
  </div>;
}
