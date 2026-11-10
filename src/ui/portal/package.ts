type Text = string;
type Url = string;
export type Rich = [
  (
    | {
        text: Text;
      }
    | {
        link: Link;
      }
  ),
  ...(
    | {
        text: Text;
      }
    | {
        link: Link;
      }
  )[]
];
type Date = string;
type Basemap =
  | { kind: 'local-layers'; water: Asset; roads: Asset; attribution: Text }
  | { kind: 'vector-style'; style_url: Url; attribution_link: Link };
type LonLat = [number, number];
type Id = string;
type Count = number;
type Page = number;
type Percent = number;

export interface CarrMarketStudyV1 {
  schema: "carr.market-study.v1";
  client: Client;
  prepared: {
    for: Text;
    on: Date;
  };
  market: {
    name: Text;
    home_title: Text;
    headline: Text;
    intro: Text;
    snapshot: [Figure, Figure, Figure];
    footer_note: Text;
    mini_map_caption: Text;
  };
  map: {
    basemap: Basemap;
    center: LonLat;
    zoom: number;
    home_extent_points?: [LonLat, LonLat, ...LonLat[]];
  };
  properties: [Property, ...Property[]];
  purchases: {
    intro: Text;
    screening_factors: [Point, Point, Point, Point, Point, Point];
    table?: {
      locator_note: Text;
      parking_note: Text;
    };
    market_context_note?: Text;
  };
  developments: Development[];
  context_anchors?: [ContextAnchor, ...ContextAnchor[]];
  demographics: Demographics;
  ownership?: Ownership;
  sources: {
    sections: [
      {
        heading: Text;
        body: Rich;
      },
      ...{
        heading: Text;
        body: Rich;
      }[]
    ];
  };
}
interface Client {
  display_name: Text;
  wordmark: {
    line1: Text;
    line2: Text;
  };
  logo?: Asset;
  website?: Url;
  current_practice?: {
    address: Text;
    size_note: Text;
    marker_letter: string;
    locator: Locator;
    source_note: Rich;
  };
}
export interface Asset {
  sha256: string;
  name: string;
  type: string;
}
interface Locator {
  lon: number;
  lat: number;
  precision: Text;
}
interface Link {
  label: Text;
  url: Url;
}
interface Figure {
  value: Text;
  label: Text;
}
interface Property {
  id: Id;
  number: number;
  address: Text;
  city?: Text;
  status: Text;
  role: "candidate" | "market-context";
  photo: Asset;
  facts: [Figure, ...Figure[]];
  summary: Text;
  review_point?: Text;
  notes?: {
    plan?: Text;
    possession?: Text;
    public_check?: Text;
  };
  floorplan?: Asset;
  sources: [Source, ...Source[]];
  source_caption?: Text;
  locator?: {
    lon: number;
    lat: number;
    precision: Text;
    preferred_offset?: [number, number];
  };
  ownership?: {
    total_sf: Count;
    asking_price: Count;
    tenure: Text;
    offering: Text;
    contiguous_sf: Count;
    available_sf?: Count;
    current_occupancy?: Text;
    current_income_annual?: Count;
  };
}
interface Source {
  date?: Date;
  label: Text;
  url: Url;
}
interface Point {
  title: Text;
  body: Text;
}
export interface Development {
  id: Id;
  title: Text;
  place: Text;
  status: Text;
  stage: Text;
  summary: Text;
  copy?: Text;
  relevance: Text;
  image: {
    asset: Asset;
    alt: Text;
    credit: Text;
    fit?: "cover" | "contain";
  };
  locator?: Locator;
  overlay?: GeoJSON;
  overlay_note?: Text;
  concept_note?: Text;
  scale?: Text;
  latest_update?: Text;
  sources: [Source, ...Source[]];
}
interface GeoJSON {
  type: "FeatureCollection";
  features: [unknown, ...unknown[]];
  [k: string]: unknown;
}
export interface ContextAnchor {
  name: Text;
  category: Text;
  address: Text;
  locator: Locator;
  source_note: Text;
  address_source_url: Url;
  locator_source_url: Url;
}
interface Demographics {
  growth: {
    area_label: Text;
    tiles: [Figure, Figure, Figure, Figure];
    geographies: [
      {
        name: Text;
        series: [
          {
            label: Text;
            value: Count;
            kind: "census" | "estimate" | "projection";
          },
          {
            label: Text;
            value: Count;
            kind: "census" | "estimate" | "projection";
          },
          ...{
            label: Text;
            value: Count;
            kind: "census" | "estimate" | "projection";
          }[]
        ];
        source_url: Url;
      },
      ...{
        name: Text;
        series: [
          {
            label: Text;
            value: Count;
            kind: "census" | "estimate" | "projection";
          },
          {
            label: Text;
            value: Count;
            kind: "census" | "estimate" | "projection";
          },
          ...{
            label: Text;
            value: Count;
            kind: "census" | "estimate" | "projection";
          }[]
        ];
        source_url: Url;
      }[]
    ];
    reach_note: Text;
    source: Rich;
  };
  age: {
    geographies: [
      {
        name: Text;
        under_18_pct: number;
        over_65_pct: number;
        source_url: Url;
      },
      ...{
        name: Text;
        under_18_pct: number;
        over_65_pct: number;
        source_url: Url;
      }[]
    ];
  };
  median_income: {
    geographies: [
      {
        name: Text;
        value: Count;
      },
      ...{
        name: Text;
        value: Count;
      }[]
    ];
    households_note: Text;
  };
  income_bands: {
    thresholds: [number, ...number[]];
    areas: [IncomeArea, ...IncomeArea[]];
    combined?: {
      label: Text;
      households: Count;
      counts: ThresholdCounts;
      caption: Text;
    };
    notes: Rich;
  };
  micro_zones?: MicroZones;
  competition?: {
    markets: [Text, ...Text[]];
    offices: [
      {
        name: Text;
        address: Text;
        market: Text;
        service_type: Text;
        services: [Text, ...Text[]];
        source_url: Url;
        logo: Asset;
        locator: Locator;
      },
      ...{
        name: Text;
        address: Text;
        market: Text;
        service_type: Text;
        services: [Text, ...Text[]];
        source_url: Url;
        logo: Asset;
        locator: Locator;
      }[]
    ];
    scope_note: Rich;
  };
  methodology: Rich;
}
interface IncomeArea {
  name: Text;
  group: "county" | "place" | "radius" | "municipal";
  households: Count;
  population?: Count;
  median?: Count;
  counts: ThresholdCounts;
  caption: Text;
}
interface ThresholdCounts {
  [k: string]: Count;
}
interface MicroZones {
  title: Text;
  description: Text;
  comparison_note: Text;
  years: [
    {
      year: number;
      label: Text;
    },
    {
      year: number;
      label: Text;
    },
    ...{
      year: number;
      label: Text;
    }[]
  ];
  estimate_year: number;
  projection_year: number;
  zones: [MicroZone, ...MicroZone[]];
}
interface MicroZone {
  id: Id;
  name: Text;
  study_pdf: Asset;
  source: {
    provider: Text;
    pages: Page;
    report_timestamp: Text;
    report_timezone?: Text;
    data_release: Text;
    geography_version: Text;
  };
  geography: {
    kind: "radius";
    center: LonLat;
    center_address: Text;
    center_precision: Text;
    radius_miles: number;
    reported_area_sq_miles: Count;
    allocation_method: Text;
    source_pages: [Page, ...Page[]];
  };
  population: {
    by_year: YearValues;
    density_per_sq_mile: Count;
    growth: {
      persons: number;
      percent: Percent;
      reported_annual_percent: Percent;
      percent_method: Text;
      annual_percent_method: Text;
    };
    source_page: Page;
  };
  households: {
    by_year: YearValues;
    with_children: {
      count: Count;
      reported_percent: Percent;
    };
    average_size: Count;
    source_page: Page;
  };
  income: {
    average_household: YearValues;
    median_household: YearValues;
    per_capita: YearValues;
    average_family: Count;
    median_family: Count;
    average_household_net_worth: Count;
    source_page: Page;
  };
  age: {
    median_years: Count;
    bins: [CountShare, ...CountShare[]];
    groups: [CountShare, ...CountShare[]];
    denominator_population: Count;
    source_page: Page;
  };
  household_income: {
    denominator_households: Count;
    bins: [CountShare, ...CountShare[]];
    thresholds: [
      {
        minimum_usd: number;
        count: Count;
        reported_percent?: Percent;
        derived_percent: Percent;
        method: Text;
      },
      ...{
        minimum_usd: number;
        count: Count;
        reported_percent?: Percent;
        derived_percent: Percent;
        method: Text;
      }[]
    ];
    source_page: Page;
  };
  housing: {
    total_units: Count;
    occupied_units: Count;
    occupied_percent_of_all_units: Percent;
    owner_occupied_units: Count;
    owner_occupied_reported_percent_of_occupied: Percent;
    renter_occupied_units: Count;
    renter_occupied_reported_percent_of_occupied: Percent;
    vacant_units: Count;
    vacant_percent_of_all_units: Percent;
    family_households: Count;
    non_family_households: Count;
    source_page: Page;
  };
  education: {
    denominator_label: Text;
    denominator_count: Count;
    bins: [CountShare, ...CountShare[]];
    bachelors_or_higher_count: Count;
    bachelors_or_higher_derived_percent: Percent;
    source_page: Page;
  };
  employment: {
    population_age_16_plus: Count;
    employed: Count;
    unemployed: Count;
    armed_forces: Count;
    not_in_labor_force: Count;
    occupation_denominator: Count;
    white_collar: Count;
    blue_collar: Count;
    businesses: Count;
    daytime_employees: Count;
    labor_source_page: Page;
    business_source_page: Page;
  };
  home_values_and_commute: {
    median_owner_home_value: Count;
    median_renter_rent: Count;
    mean_commute_minutes: Count;
    source_page: Page;
  };
}
interface YearValues {
  [k: string]: Count;
}
interface CountShare {
  label: Text;
  count: Count;
  reported_percent?: Percent;
  derived_percent: Percent;
}
interface Ownership {
  program: {
    min_share: number;
    min_sf: Count;
  };
  defaults: {
    financed_pct: number;
    rate: number;
    years: number;
    rent_psf: Count;
    collection_pct: number;
    buildout_psf: Count;
    lease_up_months: number;
    appreciation_pct: Percent;
    ti_options: [Count, Count, Count];
  };
  default_property: Id;
  copy: {
    intro: Text;
    benefits: [Point, Point, Point, Point];
    notes: Rich;
    methods: Rich;
  };
}

export function portalAsset(asset: Asset) {
  return /^[a-f0-9]{64}$/.test(asset.sha256) ? `files/${asset.sha256}` : undefined;
}
