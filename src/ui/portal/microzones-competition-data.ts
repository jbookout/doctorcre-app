export type Text = string;

export type MicroZone = {
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
  source_pages: readonly (Page)[];
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
  bins: readonly (CountShare)[];
  groups: readonly (CountShare)[];
  denominator_population: Count;
  source_page: Page;
};
  household_income: {
  denominator_households: Count;
  bins: readonly (CountShare)[];
  thresholds: readonly ({
  minimum_usd: number;
  count: Count;
  reported_percent?: Percent;
  derived_percent: Percent;
  method: Text;
})[];
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
  bins: readonly (CountShare)[];
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
};

export type Id = string;

export type Asset = {
  sha256: string;
  name: string;
  type: string;
};

export type Page = number;

export type LonLat = readonly number[];

export type Count = number;

export type YearValues = Readonly<Record<string, Count>>;

export type Percent = number;

export type CountShare = {
  label: Text;
  count: Count;
  reported_percent?: Percent;
  derived_percent: Percent;
};

export type MicroZones = {
  title: Text;
  description: Text;
  comparison_note: Text;
  years: readonly ({
  year: number;
  label: Text;
})[];
  estimate_year: number;
  projection_year: number;
  zones: readonly (MicroZone)[];
};

export type Url = string;

export type Locator = {
  lon: number;
  lat: number;
  precision: Text;
};

export type Rich = readonly (({
  text: Text;
} | {
  link: Link;
}))[];

export type Link = {
  label: Text;
  url: Url;
};

export type Competition = {
  markets: readonly (Text)[];
  offices: readonly ({
  name: Text;
  address: Text;
  market: Text;
  service_type: Text;
  services: readonly (Text)[];
  source_url: Url;
  logo: Asset;
  locator: Locator;
})[];
  scope_note: Rich;
};
