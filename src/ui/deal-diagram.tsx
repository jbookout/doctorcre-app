import type { KeyboardEvent } from "react";
import { createContext, type ReactNode, type Ref, useContext, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { RelationshipKey } from "./relationship-shapes.ts";

type Partner = "joe" | "dell";
export interface Role {
  role: string;
  label: string;
}
// One deal of the engine's client deals read, GET /api/engine/clients/{id}/deals.
export interface ClientDeal {
  id: string;
  name: string;
  client_id?: string;
  client_name?: string;
  phase: string | null;
  phase_label: string | null;
  open: boolean;
  closed_on: string | null;
  owner: Partner;
  vendors: { party_id: string; name: string; roles: Role[]; introduction_id: string | null }[];
  introductions: {
    id: string;
    version?: string;
    vendor_id: string;
    vendor_name: string;
    made_by: "vendor" | "team" | "client";
    removable?: boolean;
    introduced_by: Partner | null;
    introduced_party_id: string;
    introduced_party_name: string;
    introduced_on: string | null;
    note: string | null;
    chosen: boolean;
  }[];
}
export type Introduction = ClientDeal["introductions"][number];

export interface Vendor {
  id: string;
  name: string;
  // The roles the vendor holds on the deal, none while only introduced.
  roles: Role[];
  chosen: boolean;
  introduction: Introduction | null;
}
interface Referral extends Vendor {
  referred: string;
}
type Introducer = Partner | "unrecorded";
type Source = Introducer | "client";
export interface DiagramClient {
  id: string;
  name: string;
  // A vendor's relationship, marked on its box in the opened view.
  relationship?: RelationshipKey;
}

function treeOf(client: DiagramClient, deal: ClientDeal) {
  const roles = new Map(deal.vendors.map((v) => [v.party_id, v.roles]));
  const vendor = (id: string, name: string, chosen: boolean, introduction: Introduction | null): Vendor => ({
    id,
    name,
    roles: roles.get(id) ?? [],
    chosen,
    introduction,
  });
  const referredBy = new Map<string, Referral>();
  const introducedFor = new Map<Source, Map<string, Vendor>>();
  for (const intro of deal.introductions) {
    const box = vendor(intro.vendor_id, intro.vendor_name, intro.chosen, intro);
    if (intro.made_by === "vendor") {
      const referred = intro.introduced_party_id === client.id ? "this client" : intro.introduced_party_name;
      referredBy.set(box.id, { ...box, referred });
      continue;
    }
    const by = intro.made_by === "client" ? "client" : (intro.introduced_by ?? "unrecorded");
    introducedFor.set(by, (introducedFor.get(by) ?? new Map()).set(box.id, box));
  }
  const list = (by: Source) => [...(introducedFor.get(by)?.values() ?? [])];
  return {
    referredBy: [...referredBy.values()],
    introducedFor: list,
    notRecorded: deal.vendors
      .filter((v) => v.introduction_id === null)
      .map((v) => vendor(v.party_id, v.name, true, null)),
  };
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const dated = (verb: string, on: string | null) => on && `${verb} ${DAY.format(new Date(on))}`;

// The opened view: dates under each name, and every introduced vendor laid out.
const Large = createContext(false);
// What a vendor box opens when the partner can act on the deal; without it a box is a label.
export type VendorMenu = (vendor: Vendor, close: () => void) => ReactNode;
const Menu = createContext<VendorMenu | null>(null);
const roleOf = (vendor: Vendor) => vendor.roles.map((r) => r.label).join(", ") || null;

type Mark = "chosen" | "introduced" | "onDeal";
export const WORD: Record<Mark, string> = { chosen: "Chosen", introduced: "Introduced", onDeal: "On the deal" };
export type Line = "chosen" | "plain" | "dashed";
const INTRODUCER_NAME: Record<Introducer, string> = { joe: "Joe", dell: "Dell", unrecorded: "Not recorded" };
export const withRole = (role: string | null, word: ReactNode) => (
  <>
    {role && `${role} · `}
    {word}
  </>
);

export type GlyphMark = Mark | "referred" | "knows" | "offered";

export function Glyph({ mark }: { mark: GlyphMark }) {
  return (
    <svg className="deal-diagram-glyph" viewBox="0 0 16 16" aria-hidden="true">
      {mark === "introduced" ? (
        <circle cx="8" cy="8" r="6" />
      ) : mark === "offered" ? (
        <circle cx="8" cy="8" r="6" strokeDasharray="2.4 2.3" />
      ) : mark === "knows" ? (
        <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" />
      ) : mark === "referred" ? (
        <path d="M2.5 8h10M9 4.5 12.5 8 9 11.5" />
      ) : (
        <>
          <circle cx="8" cy="8" r="7" className="deal-diagram-fill" />
          <path d="m5 8.2 2 2 4-4.2" />
        </>
      )}
    </svg>
  );
}

interface BoxProps {
  tone: string;
  lead: ReactNode;
  name: string;
  caption: ReactNode;
  detail?: string | null | undefined;
  trail?: ReactNode;
  boxRef?: Ref<HTMLDivElement> | undefined;
  // A box that opens a menu is a button: Enter or Space toggles it, Esc closes it.
  toggle?: { open: boolean; flip: () => void } | undefined;
}

export function Box({ tone, lead, name, caption, detail, trail, boxRef, toggle }: BoxProps) {
  const button = toggle && {
    role: "button",
    tabIndex: 0,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": toggle.open,
    onClick: toggle.flip,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      const closing = event.key === "Escape" && toggle.open;
      if (event.key !== "Enter" && event.key !== " " && !closing) return;
      event.preventDefault();
      event.stopPropagation();
      toggle.flip();
    },
  };
  return (
    <div className="deal-diagram-box" data-tone={tone} ref={boxRef} tabIndex={boxRef ? -1 : undefined} {...button}>
      {lead}
      <span className="deal-diagram-text">
        <b>{name}</b>
        <span>{caption}</span>
        {detail && <span className="deal-diagram-date">{detail}</span>}
      </span>
      {trail}
    </div>
  );
}

function VendorBox({
  vendor,
  mark,
  trail,
  boxRef,
  still = false,
  referred,
}: {
  vendor: Vendor;
  mark: Mark;
  trail?: ReactNode;
  boxRef?: Ref<HTMLDivElement> | undefined;
  // A box inside the stacked pile is part of the pile's own button.
  still?: boolean;
  referred?: string;
}) {
  const menu = useContext(Menu);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = ({ target }: PointerEvent) =>
      (target instanceof Node && wrap.current?.contains(target)) || setOpen(false);
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const caption = withRole(
    roleOf(vendor),
    referred ? `Referred ${referred}` : <span className="deal-diagram-word">{WORD[mark]}</span>,
  );
  const detail = useContext(Large)
    ? dated(referred ? "Referred" : "Introduced", vendor.introduction?.introduced_on ?? null)
    : null;
  const box = (toggle?: BoxProps["toggle"]) => (
    <Box
      tone={referred ? "person" : mark}
      lead={<Glyph mark={referred ? "referred" : mark} />}
      name={vendor.name}
      caption={caption}
      detail={detail}
      trail={trail}
      boxRef={boxRef}
      toggle={toggle}
    />
  );
  if (!menu || still) return box();
  const close = () => {
    setOpen(false);
    wrap.current?.querySelector<HTMLElement>(".deal-diagram-box")?.focus();
  };
  return (
    <div className="deal-diagram-vendor" ref={wrap}>
      {box({ open, flip: () => setOpen(!open) })}
      {open && menu(vendor, close)}
    </div>
  );
}

export function Branch({ line, children }: { line: Line; children: ReactNode }) {
  return <li data-line={line}>{children}</li>;
}

// Introduced vendors nobody chose sit stacked like a solitaire pile until a partner fans them out.
function Vendors({ vendors }: { vendors: Vendor[] }) {
  const [fanned, setFanned] = useState(useContext(Large));
  const chosen = vendors.filter((vendor) => vendor.chosen);
  const passed = vendors.filter((vendor) => !vendor.chosen);
  const [top] = passed;
  const stacked = top && passed.length > 1 && !fanned;
  const pile = useRef<HTMLButtonElement>(null);
  const firstFanned = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  // The button a partner pressed unmounts, so hand focus to the control that replaces it.
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (fanned ? firstFanned : pile).current?.focus();
  }, [fanned]);
  const toggle = (next: boolean) => {
    moveFocus.current = true;
    setFanned(next);
  };
  return (
    <>
      {chosen.map((vendor) => (
        <Branch key={vendor.id} line="chosen">
          <VendorBox vendor={vendor} mark="chosen" />
        </Branch>
      ))}
      {stacked ? (
        <Branch line="plain">
          <button
            type="button"
            className="deal-diagram-pile"
            data-depth={Math.min(passed.length - 1, 2)}
            aria-expanded="false"
            aria-label={`Show all ${passed.length} introduced vendors, starting with ${[top.name, roleOf(top), "introduced"].filter(Boolean).join(", ")}`}
            ref={pile}
            onClick={() => toggle(true)}
          >
            <VendorBox
              vendor={top}
              mark="introduced"
              still
              trail={<span className="deal-diagram-count">+{passed.length - 1}</span>}
            />
          </button>
        </Branch>
      ) : (
        passed.map((vendor, index) => (
          <Branch key={vendor.id} line="plain">
            <VendorBox vendor={vendor} mark="introduced" boxRef={index === 0 ? firstFanned : undefined} />
          </Branch>
        ))
      )}
      {fanned && passed.length > 1 && (
        <li data-line="plain" className="deal-diagram-restack">
          <button type="button" aria-expanded="true" onClick={() => toggle(false)}>
            Stack the {passed.length} introduced
          </button>
        </li>
      )}
    </>
  );
}

function IntroducerBranch({ by, label, vendors }: { by: Introducer; label: string; vendors: Vendor[] }) {
  const lead = by !== "unrecorded" && (
    <span className="deal-diagram-initial" aria-hidden="true">
      {INTRODUCER_NAME[by][0]}
    </span>
  );
  return (
    <Branch line="plain">
      <Box tone="person" lead={lead} name={INTRODUCER_NAME[by]} caption={label} />
      {vendors.length > 0 && (
        <ul>
          <Vendors vendors={vendors} />
        </ul>
      )}
    </Branch>
  );
}

interface DiagramProps {
  client: DiagramClient;
  deal: ClientDeal;
  menu?: VendorMenu | null;
}

function Diagram({ client, deal, large }: { client: DiagramClient; deal: ClientDeal; large: boolean }) {
  const subject =
    deal.client_id && deal.client_id !== client.id
      ? { id: deal.client_id, name: deal.client_name ?? client.name }
      : client;
  const { referredBy, introducedFor, notRecorded } = treeOf(subject, deal);
  const others = (["joe", "dell", "unrecorded"] as const).filter((by) => by !== deal.owner);
  return (
    <Large.Provider value={large}>
      <div className="deal-diagram" data-size={large ? "large" : undefined}>
        <Box tone="client" lead={null} name={subject.name} caption="Client" />
        <ul>
          {referredBy.map((vendor) => (
            <Branch key={vendor.id} line="plain">
              <VendorBox vendor={vendor} mark={vendor.chosen ? "chosen" : "introduced"} referred={vendor.referred} />
            </Branch>
          ))}
          <IntroducerBranch by={deal.owner} label="Deal owner" vendors={introducedFor(deal.owner)} />
          <Vendors vendors={introducedFor("client")} />
          {others.map(
            (by) =>
              introducedFor(by).length > 0 && (
                <IntroducerBranch key={by} by={by} label="Introduced" vendors={introducedFor(by)} />
              ),
          )}
          {notRecorded.length > 0 && (
            <li data-line="dashed" className="deal-diagram-junction">
              <span>Brought in by: not recorded</span>
              <ul data-line="dashed">
                {notRecorded.map((vendor) => (
                  <Branch key={vendor.id} line="dashed">
                    <VendorBox vendor={vendor} mark="onDeal" />
                  </Branch>
                ))}
              </ul>
            </li>
          )}
        </ul>
      </div>
    </Large.Provider>
  );
}

export function DealDiagram({ menu = null, large = false, ...props }: DiagramProps & { large?: boolean }) {
  return (
    <Menu.Provider value={menu}>
      <Diagram {...props} large={large} />
    </Menu.Provider>
  );
}

export function mountDealDiagram(host: HTMLElement, props: DiagramProps) {
  const root = createRoot(host);
  flushSync(() => root.render(<DealDiagram {...props} />));
  return { dispose: () => flushSync(() => root.unmount()) };
}
