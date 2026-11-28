import { useCallback, useEffect, useRef, useState } from "react";
import { centralToday } from "./central-time.ts";
import { type ClientDeal, dated, type Introduction, type Role, type Vendor } from "./deal-diagram.tsx";

type SaveFailed = { ok: false; problem?: { error?: string }; done?: number; pending?: boolean };
export type Saved = { ok: true } | SaveFailed;
export interface FoundVendor {
  id: string;
  name: string;
}

const SOURCES = { dell: "Dell", joe: "Joe", client: "The client", unrecorded: "Not recorded" } as const;
export type BroughtBy = keyof typeof SOURCES;
type IntroductionVersion = { id: string; version: string };
export type RecordedSource = { id: string; version?: string; by: Exclude<BroughtBy, "unrecorded"> };
type SavedSource = RecordedSource & {
  on: string;
  party: string;
};
type SourceSave = { ok: true; introduction: SavedSource | null } | SaveFailed;
const SAVE_STATUS = {
  ready: "",
  saving: "Saving…",
  slow: "Still saving…",
  unconfirmed: "Couldn't confirm the save",
  checking: "Checking the save…",
};
type LinkPhase = keyof typeof SAVE_STATUS;

type VendorStatus = { phase: LinkPhase; problem: string };

export function VendorSaveStatus({ phase, problem, check }: VendorStatus & { check: () => void }) {
  if (phase === "ready")
    return problem ? (
      <p className="deal-vendor-menu-problem" role="alert">
        {problem}
      </p>
    ) : null;
  return (
    <p className="deal-vendor-menu-problem" role="status">
      {SAVE_STATUS[phase]}{" "}
      {(phase === "unconfirmed" || phase === "checking") && (
        <button type="button" onClick={check}>
          Check again
        </button>
      )}
    </p>
  );
}

export interface VendorActions {
  locked(vendor: string): boolean;
  registerNotice(deal: string, vendor: string, node: HTMLElement): () => void;
  setSource(vendor: FoundVendor, by: BroughtBy, replaces?: RecordedSource): Promise<Saved>;
  removeIntroduction(vendor: FoundVendor, introduction: IntroductionVersion): Promise<Saved>;
  add(vendor: FoundVendor, role: Role, showSource?: boolean): Promise<Saved>;
  remove(vendor: Vendor): Promise<Saved>;
}

export function sourceOf(introduction: Introduction | null | undefined): RecordedSource | null {
  if (!introduction || introduction.made_by === "vendor") return null;
  const by = introduction.made_by === "client" ? "client" : introduction.introduced_by;
  return by ? { id: introduction.id, by, ...(introduction.version && { version: introduction.version }) } : null;
}

export interface VendorDoors {
  add(deal: string, party: string, role: string): Promise<Saved>;
  recordSource(source: {
    deal: string;
    client: string;
    vendor: string;
    by: BroughtBy;
    on: string;
    replaces?: IntroductionVersion;
    guarded: boolean;
  }): Promise<SourceSave>;
  removeIntroduction(introduction: IntroductionVersion): Promise<Saved>;
  findVendors(query: string, signal: AbortSignal): Promise<FoundVendor[]>;
  remove(deal: string, party: string, role: string): Promise<Saved>;
  roles(signal: AbortSignal): Promise<Role[]>;
  vendorHref(party: string): string;
  openVendor(party: string): void;
}
export const broughtBy = (by: BroughtBy) => SOURCES[by];

export function SourceChoices({
  by,
  select,
  client,
  unrecorded,
  disabled,
}: {
  by: BroughtBy | null;
  select: (by: BroughtBy) => void;
  client: boolean;
  unrecorded?: boolean;
  disabled: boolean;
}) {
  const choices: BroughtBy[] = ["dell", "joe"];
  if (client) choices.push("client");
  if (unrecorded) choices.push("unrecorded");
  return (
    <fieldset disabled={disabled}>
      <legend>Who brought them in</legend>
      {choices.map((key) => (
        <button key={key} type="button" aria-pressed={by === key} onClick={() => select(key)}>
          {broughtBy(key)}
        </button>
      ))}
    </fieldset>
  );
}

export function recordSource(
  doors: VendorDoors,
  deal: ClientDeal,
  client: string,
  vendor: string,
  by: BroughtBy,
  replaces?: RecordedSource,
) {
  if (replaces && !replaces.version)
    return Promise.resolve<SaveFailed>({ ok: false, problem: { error: "version_conflict" } });
  return doors
    .recordSource({
      deal: deal.id,
      client: by === "client" ? (deal.client_id ?? client) : client,
      vendor,
      by,
      on: centralToday(new Date()),
      ...(replaces?.version && { replaces: { id: replaces.id, version: replaces.version } }),
      guarded: Boolean(deal.client_id),
    })
    .catch((): SaveFailed => ({ ok: false, pending: true }));
}
const PARTNER = { joe: "Joe", dell: "Dell" } as const;
const REFUSALS: Record<string, string> = {
  introduction_already_recorded: "A source is already recorded. Open the vendor box to see it.",
  version_conflict: "The introduction changed. Open the vendor box to review it.",
  not_found: "That vendor isn't on this deal anymore.",
  database_refused_the_statement: "The database turned this down. They may already be on the deal in that role.",
};

export function refusal(problem: { error?: string } = {}) {
  return REFUSALS[problem.error ?? ""] ?? "This wasn't saved. Try again.";
}

// Sends one save per role, stopping at the first refusal.
export async function eachRole(roles: Role[], save: (role: Role) => Promise<Saved>): Promise<Saved> {
  // eslint-disable-next-line no-restricted-syntax -- Only one save per role the vendor holds on this deal, no retries.
  for (const [done, role] of roles.entries()) {
    const saved = await save(role);
    if (!saved.ok) return { ...saved, done };
  }
  return { ok: true };
}

function introduced({ introduction }: Vendor) {
  if (!introduction) return "Brought in by: not recorded";
  if (introduction.made_by === "client")
    return `${dated("Introduced", introduction.introduced_on) || "Introduced"} by the client.`;
  if (introduction.made_by === "vendor")
    return `${dated("Referred", introduction.introduced_on) || "Referred"} ${introduction.introduced_party_name}.`;
  const who = introduction.introduced_by ? PARTNER[introduction.introduced_by] : "the team";
  return `${dated("Introduced", introduction.introduced_on) || "Introduced"} by ${who}.`;
}

type Step =
  | { at: "menu" }
  | { at: "role"; roles: Role[] | "failed" | null; role: string }
  | { at: "confirm" }
  | { at: "remove-introduction"; introduction: IntroductionVersion }
  | { at: "source"; by: BroughtBy | null };

interface Props {
  deal: ClientDeal;
  vendor: Vendor;
  doors: VendorDoors;
  actions: VendorActions;
  close: () => void;
}

export function DealVendorMenu({ deal, vendor, doors, actions, close }: Props) {
  const [step, setStep] = useState<Step>({ at: "menu" });
  const busy = actions.locked(vendor.id);
  const { registerNotice } = actions;
  const notice = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) return registerNotice(deal.id, vendor.id, node);
    },
    [deal.id, vendor.id, registerNotice],
  );
  const panel = useRef<HTMLDivElement>(null);
  const picking = step.at === "role";
  const focusKey = picking ? `role:${Boolean(step.roles)}` : step.at;
  useEffect(() => {
    if (focusKey) panel.current?.querySelector<HTMLElement>("select:enabled, button:enabled, a")?.focus();
  }, [focusKey]);
  useEffect(() => {
    if (!picking) return;
    const controller = new AbortController();
    const loaded = (roles: Role[] | "failed") => {
      if (!controller.signal.aborted) setStep((now) => (now.at === "role" ? { ...now, roles } : now));
    };
    doors.roles(controller.signal).then(loaded, () => loaded("failed"));
    return () => controller.abort();
  }, [doors, picking]);
  async function run(save: () => Promise<Saved>) {
    const answer = await save();
    if (!answer.ok) {
      if (answer.pending) setStep({ at: "menu" });
      return;
    }
    if (panel.current) close();
  }
  const onDeal = vendor.roles.length > 0;
  const introduction = vendor.introduction;
  const role = vendor.roles.map((r) => r.label).join(", ");
  return (
    <div
      className="deal-vendor-menu"
      role="dialog"
      aria-label={`${vendor.name} on ${deal.name}`}
      ref={panel}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || busy) return;
        event.stopPropagation();
        close();
      }}
    >
      <p className="deal-vendor-menu-who">
        {vendor.name}
        {role && ` · ${role}`}
        <span>{introduced(vendor)}</span>
        {vendor.introduction?.note && <q>{vendor.introduction.note}</q>}
      </p>
      <div ref={notice} />
      {step.at === "menu" && !busy && (
        <>
          {!vendor.chosen && (
            <button type="button" onClick={() => setStep({ at: "role", roles: null, role: "" })}>
              Mark chosen
            </button>
          )}
          {!introduction && deal.client_id && (
            <button type="button" onClick={() => setStep({ at: "source", by: null })}>
              Set
            </button>
          )}
          {introduction?.removable && introduction.version && (
            <button
              type="button"
              onClick={() => {
                if (introduction.version)
                  setStep({
                    at: "remove-introduction",
                    introduction: { id: introduction.id, version: introduction.version },
                  });
              }}
            >
              Remove introduction
            </button>
          )}
          <a
            href={doors.vendorHref(vendor.id)}
            onClick={(event) => {
              if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              doors.openVendor(vendor.id);
            }}
          >
            Open {vendor.name}
          </a>
          {onDeal && (
            <button type="button" onClick={() => setStep({ at: "confirm" })}>
              Remove from this deal
            </button>
          )}
        </>
      )}
      {step.at === "role" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const role = (step.roles === "failed" ? null : step.roles)?.find((role) => role.role === step.role);
            if (role) void run(() => actions.add(vendor, role));
          }}
        >
          <label>
            Chosen as
            <select
              value={step.role}
              disabled={!step.roles || step.roles === "failed"}
              onChange={(event) => setStep({ ...step, role: event.target.value })}
            >
              <option value="" disabled>
                {step.roles ? "Pick a role" : "Loading roles…"}
              </option>
              {step.roles !== "failed" &&
                step.roles?.map((r) => (
                  <option key={r.role} value={r.role}>
                    {r.label}
                  </option>
                ))}
            </select>
          </label>
          <span className="deal-vendor-menu-row">
            <button type="submit" disabled={busy || !step.role}>
              Mark chosen
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
          </span>
        </form>
      )}
      {step.at === "source" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const by = step.by;
            if (busy || !by) return;
            void run(() => actions.setSource(vendor, by));
          }}
        >
          <SourceChoices by={step.by} select={(by) => setStep({ at: "source", by })} client disabled={busy} />
          <span className="deal-vendor-menu-row">
            <button type="submit" disabled={busy || !step.by}>
              Set
            </button>
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </span>
        </form>
      )}
      {step.at === "remove-introduction" && (
        <>
          <p>
            Remove the introduction for {vendor.name} on {deal.name}?
          </p>
          <span className="deal-vendor-menu-row">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => actions.removeIntroduction(vendor, step.introduction))}
            >
              Remove
            </button>
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </span>
        </>
      )}
      {step.at === "confirm" && (
        <>
          <p>
            Remove {vendor.name} from {deal.name}?
          </p>
          <span className="deal-vendor-menu-row">
            <button type="button" disabled={busy} onClick={() => void run(() => actions.remove(vendor))}>
              Remove
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
          </span>
        </>
      )}
      {step.at === "role" && step.roles === "failed" && (
        <p className="deal-vendor-menu-problem" role="alert">
          The roles couldn't load. Try again.
        </p>
      )}
    </div>
  );
}
