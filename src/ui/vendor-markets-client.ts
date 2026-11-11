type MarketPerson = {
  contact: { id: string; name: string; email: string | null; phone: string | null; cell: string | null };
  company: { name: string } | null;
  office: { street_address: string; city: string; state: string; source: string } | null;
};
type MarketVendor = {
  id: string;
  ref: string;
  name: string | null;
  category: string | null;
  market_slugs: string[];
  people: MarketPerson[];
};
export type VendorMarket = {
  slug: string;
  name: string;
  kind: "market" | "regional";
  boundary: string;
  source: string;
  aliases: string[];
  vendor_count: number;
  memberships: { market_slug: string; vendor_id: string; office_presence: boolean; service_coverage: string | null }[];
  regional_references: { market_slug: string; regional_slug: string; note: string }[];
};
export type VendorMarkets = {
  schema_version: "vendor-markets.v1";
  state: "ready" | "empty";
  selected_market: string | null;
  markets: VendorMarket[];
  vendors: MarketVendor[];
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid market object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string") throw Error("Invalid market text");
  return value;
}
function nullable(value: unknown) {
  return value === null ? null : text(value);
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("Invalid market list");
  return value;
}
function strings(value: unknown) {
  return rows(value).map(text);
}
function person(value: unknown): MarketPerson {
  const p = object(value),
    c = object(p.contact),
    o = p.office === null ? null : object(p.office);
  return {
    contact: {
      id: text(c.id),
      name: text(c.name),
      email: nullable(c.email),
      phone: nullable(c.phone),
      cell: nullable(c.cell),
    },
    company: p.company === null ? null : { name: text(object(p.company).name) },
    office: o
      ? { street_address: text(o.street_address), city: text(o.city), state: text(o.state), source: text(o.source) }
      : null,
  };
}
export function parseVendorMarkets(value: unknown): VendorMarkets {
  const p = object(value);
  if (p.ok !== true || p.schema_version !== "vendor-markets.v1" || (p.state !== "empty" && p.state !== "ready"))
    throw Error("Unsupported vendor market response");
  const markets = rows(p.markets).map((value): VendorMarket => {
    const m = object(value);
    if (m.kind !== "market" && m.kind !== "regional") throw Error("Invalid market kind");
    if (typeof m.vendor_count !== "number" || !Number.isSafeInteger(m.vendor_count) || m.vendor_count < 0)
      throw Error("Invalid market count");
    return {
      slug: text(m.slug),
      name: text(m.name),
      kind: m.kind,
      boundary: text(m.boundary),
      source: text(m.source),
      aliases: strings(m.aliases),
      vendor_count: m.vendor_count,
      memberships: rows(m.memberships).map((value) => {
        const x = object(value);
        if (typeof x.office_presence !== "boolean") throw Error("Invalid office declaration");
        return {
          market_slug: text(x.market_slug),
          vendor_id: text(x.vendor_id),
          office_presence: x.office_presence,
          service_coverage: nullable(x.service_coverage),
        };
      }),
      regional_references: rows(m.regional_references).map((value) => {
        const x = object(value);
        return { market_slug: text(x.market_slug), regional_slug: text(x.regional_slug), note: text(x.note) };
      }),
    };
  });
  const vendors = rows(p.vendors).map((value): MarketVendor => {
    const v = object(value);
    return {
      id: text(v.id),
      ref: text(v.ref),
      name: nullable(v.name),
      category: nullable(v.category),
      market_slugs: strings(v.market_slugs),
      people: rows(v.people).map(person),
    };
  });
  const selected_market = nullable(p.selected_market);
  if (
    markets.length > 100 ||
    new Set(markets.map((m) => m.slug)).size !== markets.length ||
    new Set(vendors.map((v) => v.id)).size !== vendors.length
  )
    throw Error("Invalid registry identity");
  if (
    p.state === "empty"
      ? markets.length || vendors.length || selected_market !== null
      : !markets.length || (selected_market !== null && !markets.some((m) => m.slug === selected_market))
  )
    throw Error("Invalid registry state");
  for (const m of markets) {
    if (
      m.vendor_count !== m.memberships.length ||
      new Set(m.memberships.map((x) => x.vendor_id)).size !== m.vendor_count
    )
      throw Error("Invalid membership count");
    for (const member of m.memberships)
      if (
        member.market_slug !== m.slug ||
        !vendors.some((v) => v.id === member.vendor_id && v.market_slugs.includes(m.slug))
      )
        throw Error("Invalid membership reference");
    for (const ref of m.regional_references)
      if (
        m.kind !== "market" ||
        ref.market_slug !== m.slug ||
        !markets.some((r) => r.slug === ref.regional_slug && r.kind === "regional")
      )
        throw Error("Invalid Regional reference");
  }
  for (const v of vendors)
    if (
      !v.market_slugs.length ||
      new Set(v.market_slugs).size !== v.market_slugs.length ||
      v.market_slugs.some(
        (slug) => !markets.some((m) => m.slug === slug && m.memberships.some((x) => x.vendor_id === v.id)),
      )
    )
      throw Error("Invalid vendor markets");
  return { schema_version: "vendor-markets.v1", state: p.state, selected_market, markets, vendors };
}
