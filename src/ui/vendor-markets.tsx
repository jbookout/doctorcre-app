import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { VendorMarket, VendorMarkets } from "./vendor-markets-client.ts";
import { parseVendorMarkets } from "./vendor-markets-client.ts";

type Options = {
  load: (market: string | null, signal: AbortSignal) => Promise<unknown>;
  category: HTMLElement[];
  href: (id: string) => string;
};
type Read = { kind: "loading" } | { kind: "unavailable" } | { kind: "ready"; page: VendorMarkets };
function Members({ market, page, href }: { market: VendorMarket; page: VendorMarkets; href: Options["href"] }) {
  return (
    <section data-market-slug={market.slug} aria-label={market.name}>
      <h3>
        {market.name} <span data-market-count>{market.vendor_count} vendors</span>
      </h3>
      <ul className="market-vendors">
        {market.memberships.map((member) => {
          const vendor = page.vendors.find((v) => v.id === member.vendor_id);
          if (!vendor) return null;
          return (
            <li key={vendor.id} data-market-vendor={vendor.id}>
              <a href={href(vendor.id)}>{vendor.name || "Vendor name not recorded"}</a>
              <p>{vendor.category || "Category not recorded"}</p>
              <p>Office presence declared in this market: {member.office_presence ? "Yes" : "No"}</p>
              <p data-service-coverage>Service coverage: {member.service_coverage || "Not recorded"}</p>
              <p data-other-markets>
                Other market references:{" "}
                {vendor.market_slugs
                  .filter((slug) => slug !== market.slug)
                  .map((slug) => page.markets.find((m) => m.slug === slug)?.name)
                  .join(", ") || "None"}
              </p>
              <details className="market-evidence">
                <summary>People &amp; evidence · {vendor.people.length}</summary>
                <ul aria-label="People">
                  {vendor.people.map((p) => (
                    <li key={p.contact.id} data-market-person={p.contact.id}>
                      <strong>{p.contact.name}</strong>
                      {p.company && <p>{p.company.name}</p>}
                      <p data-office-evidence>
                        Office location:{" "}
                        {p.office
                          ? `${p.office.street_address}, ${p.office.city}, ${p.office.state}`
                          : "Verified street address not recorded"}
                      </p>
                      {p.office && <p>Office source: {p.office.source}</p>}
                      {p.contact.email && <p>{p.contact.email}</p>}
                      {(p.contact.phone || p.contact.cell) && <p>{p.contact.phone || p.contact.cell}</p>}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
      <details className="market-registry">
        <summary>Registry evidence</summary>
        <p>{market.boundary}</p>
        <p>Registry source: {market.source}</p>
      </details>
    </section>
  );
}
function replaceVendorUrl(view: "category" | "market", market: string | null) {
  const url = new URL(location.href);
  if (view === "market") url.searchParams.set("vendorView", "market");
  else url.searchParams.delete("vendorView");
  if (view === "market" && market) url.searchParams.set("vendorMarket", market);
  else url.searchParams.delete("vendorMarket");
  history.replaceState(history.state, "", url);
}
function VendorMarketsView({ options }: { options: Options }) {
  const initial = new URL(location.href).searchParams;
  const [view, setView] = useState<"category" | "market">(
    initial.get("vendorView") === "market" ? "market" : "category",
  );
  const [request, setRequest] = useState({ market: initial.get("vendorMarket") });
  const selection = request.market;
  const setSelection = (market: string | null) => {
    setRequest({ market });
    replaceVendorUrl("market", market);
  };
  const [read, setRead] = useState<Read>({ kind: "loading" });
  useEffect(() => {
    for (const node of options.category) node.hidden = view === "market";
    return () => {
      for (const node of options.category) node.hidden = false;
    };
  }, [view, options]);
  useEffect(() => {
    if (view !== "market") return;
    const controller = new AbortController();
    let current = true;
    setRead({ kind: "loading" });
    void options
      .load(request.market, controller.signal)
      .then((value) => {
        if (!current) return;
        const page = parseVendorMarkets(value);
        if (selection && page.state === "ready" && !page.selected_market) throw Error("Unresolved producer alias");
        if (page.selected_market !== selection) {
          setRequest({ market: page.selected_market });
          replaceVendorUrl("market", page.selected_market);
        }
        setRead({ kind: "ready", page });
      })
      .catch(() => {
        if (current) setRead({ kind: "unavailable" });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [view, request, selection, options]);
  const page = read.kind === "ready" ? read.page : null;
  const market = page?.markets.find((m) => m.slug === page.selected_market);
  return (
    <section className="vendor-markets" aria-label="Vendor directory view">
      <div className="market-toolbar">
        <fieldset aria-label="Browse vendors by">
          {(["category", "market"] as const).map((v) => (
            <button
              type="button"
              key={v}
              aria-pressed={view === v}
              onClick={() => {
                replaceVendorUrl(v, selection);
                setView(v);
              }}
            >
              {v === "category" ? "Category" : "Market"}
            </button>
          ))}
        </fieldset>
        {view === "market" && (
          <button type="button" disabled={read.kind === "loading"} onClick={() => setRequest({ ...request })}>
            Refresh markets
          </button>
        )}
      </div>
      {view === "market" && (
        <div aria-busy={read.kind === "loading"}>
          <h2>Reviewed vendor markets</h2>
          {read.kind === "loading" && <p role="status">Loading reviewed markets…</p>}
          {read.kind === "unavailable" && (
            <p role="alert">Reviewed markets unavailable. Refresh markets to try again.</p>
          )}
          {page?.state === "empty" && (
            <p role="status">
              No reviewed markets yet. A reviewed registry is needed before market browsing is available.
            </p>
          )}
          {page?.state === "ready" && (
            <>
              <label className="field">
                Reviewed market
                <select
                  aria-label="Reviewed market"
                  value={page.selected_market ?? ""}
                  onChange={(e) => setSelection(e.currentTarget.value || null)}
                >
                  <option value="">Choose a reviewed market</option>
                  {page.markets.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name}
                      {m.kind === "regional" ? " · Regional" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {market && (
                <>
                  <Members market={market} page={page} href={options.href} />
                  {market.kind === "market" && (
                    <section aria-label="Regional coverage references">
                      <h2>Regional coverage references</h2>
                      <p>These vendors are separate from the selected market count.</p>
                      {market.regional_references.length === 0 && <p>No Regional references recorded.</p>}
                      {market.regional_references.map((ref) => {
                        const regional = page.markets.find((m) => m.slug === ref.regional_slug);
                        return regional ? (
                          <div key={regional.slug}>
                            <p>{ref.note}</p>
                            <Members market={regional} page={page} href={options.href} />
                          </div>
                        ) : null;
                      })}
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
export function mountVendorMarkets(host: HTMLElement, options: Options) {
  const root = createRoot(host);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("doctorcre-session-invalidated", dispose);
    flushSync(() => root.unmount());
  };
  window.addEventListener("doctorcre-session-invalidated", dispose);
  flushSync(() => root.render(<VendorMarketsView options={options} />));
  return { dispose };
}
