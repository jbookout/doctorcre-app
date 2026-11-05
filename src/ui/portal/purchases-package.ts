export type Text = string;
export type Id = string;
export type Count = number;
export type Date = string;
export type Url = string;
export interface Asset {
  sha256: string;
  name: string;
  type: string;
}
export interface Figure {
  value: Text;
  label: Text;
}
export interface Property {
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
export interface Source {
  date?: Date;
  label: Text;
  url: Url;
}
export interface Locator {
  lon: number;
  lat: number;
  precision: Text;
}
export interface Point {
  title: Text;
  body: Text;
}
export interface Link {
  label: Text;
  url: Url;
}
export type PurchasePackage = {
  properties: readonly Property[];
  purchases: { intro: string; screening_factors: readonly Point[]; table?: { locator_note: string; parking_note: string }; market_context_note?: string };
  map: { center: [number, number]; zoom: number; basemap: { kind: 'local-layers'; water: Asset; roads: Asset; attribution: string } | { kind: 'vector-style'; style_url: string; attribution_link: Link } };
};
