import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ContextMarker } from "./home-map";
import { HomeMap } from "./home-map";
import type { CarrMarketStudyV1, ContextAnchor, Development, Rich } from "./package";
import { portalAsset } from "./package";
import type { ProposalScope, ProposalTransport } from "./proposal-ports";
import { proposalSelectionPorts } from "./proposal-ports";
import { trackShellGeometry } from "./shell-geometry";
import { TourList } from "./tour-list-signout";
import type { SelectionPorts } from "./tour-list-state";
import { createTourList } from "./tour-list-state";

export type MarketStudy = CarrMarketStudyV1;
export type PortalRoute = string;
export type PortalModule = {
  route: PortalRoute;
  label: string;
  available: (publication: MarketStudy) => boolean;
  render: (publication: MarketStudy, openProperty: (id: string) => void) => ReactNode;
};
export type PortalProposals = { scope: ProposalScope; transport: ProposalTransport } & Pick<
  SelectionPorts,
  "signOut" | "clearPrivateState" | "returnToGate"
>;
export type PortalOptions = { package: MarketStudy; modules?: readonly PortalModule[]; proposals?: PortalProposals };

export function ExternalLink({ url, children }: { url: string; children: ReactNode }) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password)
      return (
        <a href={parsed.href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
  } catch {}
  return <span>{children}</span>;
}
export function RichText({ runs }: { runs: Rich }) {
  return (
    <>
      {runs.map((run) =>
        "text" in run ? (
          <span key={run.text}>{run.text}</span>
        ) : (
          <ExternalLink key={run.link.url + run.link.label} url={run.link.url}>
            {run.link.label}
          </ExternalLink>
        ),
      )}
    </>
  );
}
export { portalAsset } from "./package";

function Wordmark({ publication }: { publication: MarketStudy }) {
  const [failed, setFailed] = useState(false);
  return publication.client.logo && !failed ? (
    <img
      className="portal-logo"
      src={portalAsset(publication.client.logo)}
      alt={publication.client.display_name}
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="portal-wordmark">
      {publication.client.wordmark.line1}
      <small>{publication.client.wordmark.line2}</small>
    </span>
  );
}
function Sources({ publication }: { publication: MarketStudy }) {
  return (
    <>
      {publication.sources.sections.map((section) => (
        <section key={section.heading}>
          <h2>{section.heading}</h2>
          <p>
            <RichText runs={section.body} />
          </p>
        </section>
      ))}
      <section>
        <h2>Listing sources</h2>
        <div className="portal-source-list">
          {publication.properties.map((property) => (
            <article key={property.id}>
              <h3>{property.address}</h3>
              <ul>
                {property.sources.map((source) => (
                  <li key={source.url + source.label}>
                    <ExternalLink url={source.url}>{source.label}</ExternalLink>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
      <section>
        <h2>Demographic sources</h2>
        <p>
          <RichText runs={publication.demographics.methodology} />
        </p>
        <p>
          <RichText runs={publication.demographics.growth.source} />
        </p>
        <ul>
          {publication.demographics.growth.geographies.map((area) => (
            <li key={area.name}>
              <ExternalLink url={area.source_url}>{area.name}</ExternalLink>
            </li>
          ))}
        </ul>
        <ul>
          {publication.demographics.age.geographies.map((area) => (
            <li key={area.name}>
              <ExternalLink url={area.source_url}>{area.name} age distribution</ExternalLink>
            </li>
          ))}
        </ul>
        {publication.demographics.micro_zones && (
          <>
            <h3>Radius reports</h3>
            <ul>
              {publication.demographics.micro_zones.zones.map((zone) => (
                <li key={zone.id}>
                  <a href={portalAsset(zone.study_pdf)} target="_blank" rel="noopener noreferrer">
                    {zone.name} report PDF
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
        {publication.demographics.competition && (
          <>
            <h3>Competitor directory sources</h3>
            <ul>
              {publication.demographics.competition.offices.map((office) => (
                <li key={office.name + office.address}>
                  <ExternalLink url={office.source_url}>{office.name}</ExternalLink>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
function DevelopmentDetails({ item }: { item: Development }) {
  return (
    <>
      <figure>
        <img
          src={portalAsset(item.image.asset)}
          alt={item.image.alt}
          style={{ objectFit: item.image.fit ?? "cover" }}
        />
        <figcaption>{item.image.credit}</figcaption>
      </figure>
      <p>
        {item.place} · {item.status} · {item.stage}
      </p>
      <p>{item.copy ?? item.summary}</p>
      {item.concept_note && <p>{item.concept_note}</p>}
      {item.locator && <p>{item.locator.precision}</p>}
      {item.latest_update && <p>{item.latest_update}</p>}
      {item.scale && <p>{item.scale}</p>}
      <h3>Market relevance</h3>
      <p>{item.relevance}</p>
      <ul>
        {item.sources.map((source) => (
          <li key={source.url + source.label}>
            <ExternalLink url={source.url}>{source.label}</ExternalLink>
            {source.date && ` · ${source.date}`}
          </li>
        ))}
      </ul>
      <a href="#sources">View primary source</a>
    </>
  );
}
type Detail = { title: string; body: ReactNode };
function anchorDetail(anchor: ContextAnchor): Detail {
  return {
    title: anchor.name,
    body: (
      <>
        <p>{anchor.address}</p>
        <p>{anchor.category}</p>
        <p>{anchor.locator.precision}</p>
        <p>{anchor.source_note}</p>
        <p>
          <ExternalLink url={anchor.address_source_url}>Address source</ExternalLink>
        </p>
        <p>
          <ExternalLink url={anchor.locator_source_url}>Locator source</ExternalLink>
        </p>
      </>
    ),
  };
}
function practiceDetail(
  publication: MarketStudy,
  practice: NonNullable<MarketStudy["client"]["current_practice"]>,
): Detail {
  return {
    title: publication.client.display_name,
    body: (
      <>
        <p>{practice.address}</p>
        <p>{practice.size_note}</p>
        <p>{practice.locator.precision}</p>
        <p>
          <RichText runs={practice.source_note} />
        </p>
        {publication.client.website && <ExternalLink url={publication.client.website}>Practice website</ExternalLink>}
      </>
    ),
  };
}
function Home({
  publication,
  open,
  available,
}: {
  publication: MarketStudy;
  open: (detail: Detail) => void;
  available: (route: PortalRoute) => boolean;
}) {
  const practice = publication.client.current_practice;
  const markers = useMemo(
    () => [
      ...publication.developments.flatMap((item, index): ContextMarker[] =>
        item.locator
          ? [
              {
                id: item.id,
                label: `${index + 1}. ${item.title}`,
                preview: item.summary,
                lon: item.locator.lon,
                lat: item.locator.lat,
                open: () => open({ title: item.title, body: <DevelopmentDetails item={item} /> }),
              },
            ]
          : [],
      ),
      ...(publication.context_anchors ?? []).map(
        (anchor, index): ContextMarker => ({
          id: `anchor-${index}`,
          label: anchor.name,
          preview: `${anchor.category} · ${anchor.address}`,
          lon: anchor.locator.lon,
          lat: anchor.locator.lat,
          open: () => open(anchorDetail(anchor)),
        }),
      ),
      ...(practice
        ? [
            {
              id: "practice",
              label: `${practice.marker_letter}. Current practice`,
              preview: practice.address,
              lon: practice.locator.lon,
              lat: practice.locator.lat,
              open: () => open(practiceDetail(publication, practice)),
            },
          ]
        : []),
    ],
    [publication, practice, open],
  );
  return (
    <>
      <section className="portal-hero">
        <Wordmark publication={publication} />
        <p>
          Prepared for {publication.prepared.for} · {publication.prepared.on}
        </p>
        <h2>{publication.market.headline}</h2>
        <p>{publication.market.intro}</p>
        <a href={available("demographics") ? "#demographics" : "#sources"}>Explore demographics and sources</a>
      </section>
      <section aria-label="Market snapshot" data-snapshot className="portal-snapshot">
        {publication.market.snapshot
          .filter((figure) => !/\b(candidate|properties|property|listings?|rents?|asking|sites)\b/i.test(figure.label))
          .map((figure) => (
            <article key={figure.label}>
              <strong>{figure.value}</strong>
              <p>{figure.label}</p>
              {available("demographics") && <a href="#demographics">Explore demographic context</a>}
            </article>
          ))}
      </section>
      <HomeMap publication={publication} markers={markers} />
      {publication.developments.length > 0 && (
        <section>
          <h2>Major development activity</h2>
          <div className="portal-directory">
            {publication.developments.map((item) => (
              <article key={item.id}>
                <img
                  className="portal-development-image"
                  src={portalAsset(item.image.asset)}
                  alt={item.image.alt}
                  loading="lazy"
                  style={{ objectFit: item.image.fit ?? "cover" }}
                />
                <p>
                  {item.place} · {item.stage}
                </p>
                <h3>{item.title}</h3>
                <p>{item.summary}</p>
                <button
                  type="button"
                  onClick={() => open({ title: item.title, body: <DevelopmentDetails item={item} /> })}
                >
                  Explore {item.title}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
      {publication.context_anchors && (
        <section>
          <h2>Regional context</h2>
          <div className="portal-directory">
            {publication.context_anchors.map((anchor) => (
              <article key={anchor.name + anchor.address}>
                <h3>{anchor.name}</h3>
                <p>{anchor.category}</p>
                <button type="button" onClick={() => open(anchorDetail(anchor))}>
                  Explore {anchor.name}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
      {practice && (
        <section>
          <h2>Current practice</h2>
          <button type="button" onClick={() => open(practiceDetail(publication, practice))}>
            Explore current practice
          </button>
        </section>
      )}
      {available("purchases") && (
        <a className="portal-cta" href="#purchases">
          Explore purchase opportunities
        </a>
      )}
    </>
  );
}
function DetailDialog({ detail, close }: { detail: Detail; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog ref={ref} aria-labelledby="portal-detail-title" onCancel={close}>
      <button type="button" onClick={close}>
        Close
      </button>
      <h2 id="portal-detail-title">{detail.title}</h2>
      {detail.body}
    </dialog>
  );
}
function Shell({ options }: { options: PortalOptions }) {
  const publication = options.package;
  const modules = (options.modules ?? []).filter((module) => module.available(publication));
  const [hash, setHash] = useState(window.location.hash);
  const [detail, setDetail] = useState<Detail | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const header = useRef<HTMLElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (header.current && shell.current) return trackShellGeometry(header.current, shell.current);
  }, []);
  const route = hash.replace(/^#/, "") || "home";
  const module = modules.find((module) => module.route === route);
  const title =
    route === "home"
      ? publication.market.home_title
      : route === "sources"
        ? "Sources"
        : (module?.label ?? "Page unavailable");
  const available = (route: PortalRoute) =>
    ["home", "sources"].includes(route) || modules.some((module) => module.route === route);
  useEffect(() => {
    const change = () => {
      setDetail(null);
      setHash(window.location.hash);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useLayoutEffect(() => {
    if (hash === window.location.hash) heading.current?.focus();
    heading.current?.scrollIntoView?.({ block: "start" });
  }, [hash]);
  return (
    <div ref={shell} className="market-study">
      <div className="scroll-progress" aria-hidden="true" />
      <button
        type="button"
        className="portal-skip"
        onClick={(event) => {
          event.preventDefault();
          heading.current?.focus();
        }}
      >
        Skip to content
      </button>
      <header ref={header} className="portal-header site-header">
        <ExternalLink url="https://www.carr.us/">CARR</ExternalLink>
        <a href="#home" aria-label={`${publication.client.display_name} Home`}>
          <Wordmark publication={publication} />
        </a>
        <nav aria-label="Market study">
          {[{ route: "home", label: "Home" }, ...modules, { route: "sources", label: "Sources" }].map((item) => (
            <a key={item.route} href={`#${item.route}`} aria-current={route === item.route ? "page" : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <main id="portal-main">
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {route === "home" ? (
          <Home publication={publication} open={setDetail} available={available} />
        ) : route === "sources" ? (
          <Sources publication={publication} />
        ) : module ? (
          module.render(publication, (id) => {
            const property = publication.properties.find((property) => property.id === id);
            if (property) setDetail({ title: property.address, body: <p>{property.summary}</p> });
          })
        ) : (
          <p>
            This page is unavailable in this publication. <a href="#home">Return Home</a>
          </p>
        )}
      </main>
      <footer>
        <p>
          CARR · {publication.client.display_name} · {publication.prepared.on}
        </p>
        <p>{publication.market.footer_note}</p>
        <a href="#sources">Sources</a>
      </footer>
      {detail && <DetailDialog detail={detail} close={() => setDetail(null)} />}
    </div>
  );
}
const mountedPortals = new WeakMap<HTMLElement, { dispose: () => void }>();
function renderMarketStudy(container: HTMLElement, options: PortalOptions) {
  if (options.proposals && options.modules?.some((module) => module.route === "tour-list"))
    throw Error("Duplicate Tour List module");
  const model = options.proposals
    ? createTourList(
        options.package.properties,
        proposalSelectionPorts({ ...options.proposals, properties: options.package.properties }),
      )
    : undefined;
  const renderedOptions = model
    ? {
        ...options,
        modules: [
          ...(options.modules ?? []),
          {
            route: "tour-list",
            label: "Tour List",
            available: () => true,
            render: (_publication: MarketStudy, openProperty: (id: string) => void) => (
              <TourList model={model} openProperty={openProperty} embedded />
            ),
          },
        ],
      }
    : options;
  const root = createRoot(container);
  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false;
    model?.dispose();
    window.removeEventListener("doctorcre-session-invalidated", expire);
    window.removeEventListener("pagehide", expire);
    flushSync(() => root.unmount());
  };
  const expire = () => {
    model?.expire();
    dispose();
    container.textContent = "Your session expired. Sign in again to continue.";
  };
  window.addEventListener("doctorcre-session-invalidated", expire);
  window.addEventListener("pagehide", expire);
  flushSync(() => root.render(<Shell options={renderedOptions} />));
  return { dispose };
}
export function mountMarketStudy(container: HTMLElement, options: PortalOptions) {
  mountedPortals.get(container)?.dispose();
  const panel = renderMarketStudy(container, options);
  mountedPortals.set(container, panel);
  return panel;
}

export function mountPortal(
  container: HTMLElement,
  options: {
    load: (options: { signal: AbortSignal }) => Promise<MarketStudy>;
    modules?: readonly PortalModule[];
    proposals?: PortalProposals;
  },
) {
  mountedPortals.get(container)?.dispose();
  const controller = new AbortController();
  let phase: "loading" | "ready" | "unavailable" | "expired" | "disposed" = "loading";
  let panel: ReturnType<typeof mountMarketStudy> | undefined;
  const clear = () => {
    controller.abort();
    panel?.dispose();
    panel = undefined;
  };
  const expire = () => {
    if (phase === "disposed") return;
    phase = "expired";
    clear();
    container.textContent = "Your session expired. Sign in again to continue.";
  };
  window.addEventListener("doctorcre-session-invalidated", expire);
  window.addEventListener("pagehide", expire);
  container.textContent = "Opening your market study…";
  const load = async () => {
    try {
      const publication = await options.load({ signal: controller.signal });
      if (phase !== "loading") return;
      phase = "ready";
      container.textContent = "";
      panel = renderMarketStudy(container, {
        package: publication,
        ...(options.modules ? { modules: options.modules } : {}),
        ...(options.proposals ? { proposals: options.proposals } : {}),
      });
    } catch {
      if (phase !== "loading") return;
      phase = "unavailable";
      container.textContent = "Market study unavailable. Try opening the portal again.";
    }
  };
  void load();
  const host = {
    dispose() {
      if (phase === "disposed") return;
      phase = "disposed";
      clear();
      window.removeEventListener("doctorcre-session-invalidated", expire);
      window.removeEventListener("pagehide", expire);
      container.textContent = "";
    },
  };
  mountedPortals.set(container, host);
  return host;
}
