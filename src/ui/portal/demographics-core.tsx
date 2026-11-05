import { useState } from 'react';
import type { ReactNode } from 'react';

type Runs = readonly ({ text: string } | { link: { label: string; url: string } })[];
type IncomeArea = {
  name: string;
  group: 'county' | 'place' | 'radius' | 'municipal';
  households: number;
  population?: number;
  median?: number;
  counts: Readonly<Record<string, number>>;
  caption: string;
};
export type DemographicsCoreData = {
  growth: {
    area_label: string;
    tiles: readonly { value: string; label: string }[];
    geographies: readonly {
      name: string;
      series: readonly { label: string; value: number; kind: 'census' | 'estimate' | 'projection' }[];
      source_url: string;
    }[];
    reach_note: string;
    source: Runs;
  };
  age: { geographies: readonly { name: string; under_18_pct: number; over_65_pct: number; source_url: string }[] };
  median_income: { geographies: readonly { name: string; value: number }[]; households_note: string };
  income_bands: {
    thresholds: readonly number[];
    areas: readonly IncomeArea[];
    combined?: { label: string; households: number; counts: Readonly<Record<string, number>>; caption: string };
    notes: Runs;
  };
  methodology: Runs;
};

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const known = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);
const count = (value: number | undefined) => known(value) ? number.format(value) : 'Unknown';
const dollars = (value: number | undefined) => known(value) ? money.format(value) : 'Unknown';

function SourceLink({ url, children }: { url: string | undefined; children: ReactNode }) {
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password)
        return <a className="chart-source" href={url} target="_blank" rel="noopener noreferrer">{children}</a>;
    } catch {}
  }
  return <span>Source unavailable</span>;
}
function TextRuns({ runs }: { runs: Runs }) {
  return <>{runs.map((run, index) => 'text' in run ? <span key={index}>{run.text}{' '}</span>
    : <SourceLink key={index} url={run.link.url}>{run.link.label}</SourceLink>)}</>;
}
function Bar({ value, max, projection = false }: { value: number | undefined; max: number; projection?: boolean }) {
  return <span className={`demographics-bar${projection ? ' demographics-projection' : ''}`} aria-hidden="true">
    <span style={{ width: `${known(value) && max > 0 ? Math.min(100, Math.max(0, value / max * 100)) : 0}%` }} />
  </span>;
}

export function DemographicsCore({ demographics }: { demographics: DemographicsCoreData | undefined }) {
  const [growthName, setGrowthName] = useState('');
  const [householdName, setHouseholdName] = useState('');
  const [incomeThreshold, setIncomeThreshold] = useState<number>();
  if (!demographics) return null;
  const { growth, age, median_income: income, income_bands: bands } = demographics;
  const growthArea = growth.geographies.find(area => area.name === growthName) ?? growth.geographies[0];
  const householdNames = [...new Set([...age.geographies.map(area => area.name), ...income.geographies.map(area => area.name)])];
  const household = householdNames.includes(householdName) ? householdName : householdNames[0];
  const ageArea = age.geographies.find(area => area.name === household);
  const threshold = incomeThreshold !== undefined && bands.thresholds.includes(incomeThreshold) ? incomeThreshold : bands.thresholds[0];
  const populationMax = Math.max(1, ...(growthArea?.series.map(point => point.value) ?? []));
  const incomeMax = Math.max(1, ...income.geographies.map(area => area.value));
  const incomeByName = new Map(income.geographies.map(area => [area.name, area.value]));
  const cards = [...(bands.combined ? [{ name: bands.combined.label, group: 'combined', ...bands.combined }] : []), ...bands.areas];
  return <div className="demographics-core" id="demographics">
    <section className="regional-growth" aria-labelledby="demographics-growth-title" data-growth>
      <h2 id="demographics-growth-title">Regional growth</h2><p>{growth.area_label}</p>
      <div className="demographics-tiles">{growth.tiles.map((tile, index) => <article key={index}><strong>{tile.value}</strong><p>{tile.label}</p></article>)}</div>
      <p>{growth.reach_note}</p><TextRuns runs={growth.source} />
      <div role="group" aria-label="Growth geography" className="demo-switch">{growth.geographies.map(area =>
        <button type="button" key={area.name} aria-pressed={area.name === growthArea?.name} onClick={() => setGrowthName(area.name)}>{area.name}</button>)}</div>
      <div id="regional-growth-chart" aria-live="polite" aria-atomic="true"><h3>{growthArea?.name ?? 'Unknown geography'}</h3>
        <table><caption>Population by published year</caption><thead><tr><th scope="col">Year and method</th><th scope="col">Population, people</th></tr></thead>
          <tbody>{growthArea?.series.map((point, index) => <tr key={index}><th scope="row">{point.label} {point.kind}</th><td>{count(point.value)}<Bar value={point.value} max={populationMax} projection={point.kind === 'projection'} /></td></tr>)}</tbody>
        </table><SourceLink url={growthArea?.source_url}>View population source for {growthArea?.name}</SourceLink>
      </div>
    </section>
      <h2 id="demographics-household-title">Local Age and Household Context</h2>
      <div role="group" aria-label="Household geography" className="demo-switch">{householdNames.map(name =>
        <button type="button" key={name} aria-pressed={name === household} onClick={() => setHouseholdName(name)}>{name}</button>)}</div>
      <div id="demo-dashboard" aria-live="polite" aria-atomic="true" data-age><h3>Age in {household ?? 'Unknown geography'}</h3>
        <table><caption>Share of population, percent</caption><thead><tr><th scope="col">Age group</th><th scope="col">Share</th></tr></thead><tbody>
          <tr><th scope="row">Under 18</th><td>{known(ageArea?.under_18_pct) ? `${count(ageArea.under_18_pct)}%` : 'Unknown'}<Bar value={ageArea?.under_18_pct} max={100} /></td></tr>
          <tr><th scope="row">65 and over</th><td>{known(ageArea?.over_65_pct) ? `${count(ageArea.over_65_pct)}%` : 'Unknown'}<Bar value={ageArea?.over_65_pct} max={100} /></td></tr>
        </tbody></table><SourceLink url={ageArea?.source_url}>View age source for {household}</SourceLink>
      </div>
      <div id="demo-comparisons" className="demo-compare" data-median><h3>Median household income</h3><p>{income.households_note}</p>
        <table><caption>Income comparison, US dollars. Selected geography is marked.</caption><thead><tr><th scope="col">Geography</th><th scope="col">Median household income</th></tr></thead>
          <tbody>{householdNames.map(name => <tr key={name} data-selected={name === household ? 'true' : undefined}><th scope="row">{name}{name === household && ' (selected)'}</th><td>{dollars(incomeByName.get(name))}<Bar value={incomeByName.get(name)} max={incomeMax} /></td></tr>)}</tbody>
        </table><SourceLink url={ageArea?.source_url}>View household context source for {household}</SourceLink>
      </div>
    <section className="regional-context" aria-labelledby="demographics-income-title" data-income-bands>
      <h2 id="demographics-income-title">Higher-Income Household Context</h2>
      <div role="group" aria-label="Household income threshold" className="income-tier-switch">{bands.thresholds.map(value =>
        <button type="button" key={value} aria-pressed={value === threshold} onClick={() => setIncomeThreshold(value)}>{dollars(value)} or more</button>)}</div>
      <p>Share equals households at or above the threshold divided by all households in each geography. Geographies may overlap.</p>
      <div id="regional-income-context" className="demographics-income-cards" aria-live="polite" aria-atomic="true">{cards.map((area, index) => {
        const total = threshold === undefined ? undefined : area.counts[String(threshold)];
        const share = known(total) && area.households > 0 ? total / area.households * 100 : undefined;
        return <article key={index}><h3>{area.name}</h3><p>{area.group}</p><p>{dollars(threshold)} or more</p>
          <p>{count(total)} of {count(area.households)} households</p><strong>{known(share) ? `${count(share)}%` : 'Unknown share'}</strong>
          <Bar value={share} max={100} /><p>{area.caption}</p>
        </article>;
      })}</div>
      <details><summary>Geography and source notes</summary><p><TextRuns runs={bands.notes} /></p></details>
    </section>
    <p className="note"><TextRuns runs={demographics.methodology} /></p>
    <details className="demo-method"><summary>Sources and methodology</summary><p><TextRuns runs={demographics.methodology} /></p></details>
  </div>;
}
