import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const PAGE_SIZE = 5;

type Proposal = {
  subject_type: string;
  subject_id: string;
  ref: string;
  name: string;
  basis: "created_at" | "last_contact";
  anchor_on: string;
  due_on: string;
  days_overdue: number;
  owner?: string | null;
};
type Snapshot = { cadence: { vendor_days: number }; proposals: Proposal[] };
type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "refused" }
  | { kind: "ready"; snapshot: Snapshot; offset: number };
type Options = {
  load: () => Promise<unknown>;
  href: (id: string) => string;
  open: (href: string, returnFocusId: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProposal(value: unknown): value is Proposal {
  if (!isRecord(value)) return false;
  return (
    typeof value.subject_type === "string" &&
    value.subject_type.trim().length > 0 &&
    typeof value.subject_id === "string" &&
    value.subject_id.trim().length > 0 &&
    typeof value.ref === "string" &&
    value.ref.trim().length > 0 &&
    typeof value.name === "string" &&
    (value.owner == null || typeof value.owner === "string") &&
    (value.basis === "created_at" || value.basis === "last_contact") &&
    typeof value.anchor_on === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.anchor_on) &&
    typeof value.due_on === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.due_on) &&
    typeof value.days_overdue === "number" &&
    Number.isSafeInteger(value.days_overdue)
  );
}

function parseSnapshot(value: unknown): Snapshot {
  if (
    !isRecord(value) ||
    !isRecord(value.cadence) ||
    typeof value.cadence.vendor_days !== "number" ||
    !Number.isSafeInteger(value.cadence.vendor_days) ||
    value.cadence.vendor_days < 1 ||
    !Array.isArray(value.proposals) ||
    value.proposals.length > 1000 ||
    !value.proposals.every(isProposal)
  )
    throw new TypeError("Invalid quiet vendor snapshot");
  return { cadence: { vendor_days: value.cadence.vendor_days }, proposals: value.proposals };
}

const ownerKey = (owner: string | null | undefined) => (owner == null ? "missing" : `owner:${owner}`);
const ownerLabel = (owner: string) => (owner === "joe" ? "Joe" : owner === "dell" ? "Dell" : owner);

type Lifetime = { disposed: boolean; reading: boolean };
function QuietVendors({ options, lifetime }: { options: Options; lifetime: Lifetime }) {
  const owner = useRef("all");
  const history = useRef<"all" | Proposal["basis"]>("all");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const action = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  async function read() {
    if (lifetime.reading || lifetime.disposed) return;
    lifetime.reading = true;
    setState({ kind: "loading" });
    try {
      const snapshot = parseSnapshot(await options.load());
      if (!lifetime.disposed) {
        const available = snapshot.proposals.filter((row) => row.subject_type === "vendor");
        const retained = owner.current === "all" || available.some((row) => ownerKey(row.owner) === owner.current);
        setNotice(retained ? "" : "The selected owner is no longer in this snapshot. Showing all owners.");
        if (!retained) owner.current = "all";
        setState({ kind: "ready", snapshot, offset: 0 });
      }
    } catch {
      if (!lifetime.disposed) setState({ kind: "refused" });
    } finally {
      lifetime.reading = false;
    }
  }
  const vendors = state.kind === "ready" ? state.snapshot.proposals.filter((row) => row.subject_type === "vendor") : [];
  const owners = [...new Set(vendors.map((row) => ownerKey(row.owner)))];
  const matching = vendors.filter(
    (row) =>
      (owner.current === "all" || ownerKey(row.owner) === owner.current) &&
      (history.current === "all" || row.basis === history.current),
  );
  return (
    <section
      className={expanded ? "quiet-vendors module-card glass" : "quiet-vendors quiet-vendors-idle"}
      aria-label="Quiet vendor follow-ups"
    >
      <h2 hidden={!expanded}>Quiet vendor follow-ups</h2>
      <p hidden={!expanded}>Review vendor relationships that CARR has marked due for attention.</p>
      <button
        ref={action}
        type="button"
        className="action"
        aria-expanded={!expanded ? false : undefined}
        aria-controls={!expanded ? "quietVendorsContent" : undefined}
        aria-disabled={expanded && state.kind === "loading"}
        onClick={() => {
          if (!expanded) {
            setExpanded(true);
            if (state.kind === "idle") void read();
          } else void read();
        }}
      >
        {!expanded
          ? "Show quiet vendors"
          : state.kind === "loading"
            ? "Loading quiet vendors…"
            : "Refresh quiet vendors"}
      </button>
      {expanded && (
        <>
          {" "}
          <button
            type="button"
            className="action"
            aria-expanded="true"
            aria-controls="quietVendorsContent"
            onClick={() => {
              action.current?.focus();
              setExpanded(false);
            }}
          >
            Hide quiet vendors
          </button>
        </>
      )}
      <div id="quietVendorsContent" hidden={!expanded} aria-busy={state.kind === "loading"}>
        {state.kind === "loading" && <p role="status">Loading the server snapshot…</p>}
        {state.kind === "refused" && (
          <p role="alert">The quiet vendor list is unavailable or was refused. Try refreshing.</p>
        )}
        {state.kind === "ready" && (
          <>
            <p>Server cadence · {state.snapshot.cadence.vendor_days} days</p>
            <label className="field">
              Quiet vendor owner{" "}
              <select
                value={owner.current}
                onChange={(event) => {
                  owner.current = event.currentTarget.value;
                  setNotice("");
                  setState({ ...state, offset: 0 });
                }}
              >
                <option value="all">All owners</option>
                {owners
                  .filter((key) => key !== "missing")
                  .map((key) => (
                    <option key={key} value={key}>
                      {ownerLabel(key.slice(6))}
                    </option>
                  ))}
                {owners.includes("missing") && <option value="missing">Owner not recorded</option>}
              </select>
            </label>
            <label className="field">
              Contact history{" "}
              <select
                value={history.current}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (value !== "all" && value !== "created_at" && value !== "last_contact") return;
                  history.current = value;
                  setState({ ...state, offset: 0 });
                }}
              >
                <option value="all">All contact history</option>
                <option value="created_at">Never contacted</option>
                <option value="last_contact">Previously contacted</option>
              </select>
            </label>
            {notice && <p role="status">{notice}</p>}
            {vendors.length === 0 ? (
              <p>No quiet vendors in this server snapshot.</p>
            ) : (
              <>
                {matching.length === 0 ? (
                  <>
                    <p role="status">0 matching loaded vendors.</p>
                    <p>No loaded vendors match these filters.</p>
                  </>
                ) : (
                  <p role="status">
                    Showing {state.offset + 1}–{Math.min(state.offset + PAGE_SIZE, matching.length)} of{" "}
                    {matching.length}{" "}
                    {owner.current === "all" && history.current === "all" ? "quiet vendors" : "matching loaded vendors"}
                    .
                  </p>
                )}
                {owner.current === "all" && <p>Counts describe loaded vendors only.</p>}
                <fieldset aria-label="Quiet vendor pages" style={{ border: 0, margin: 0, padding: 0 }}>
                  <button
                    type="button"
                    className="action"
                    aria-disabled={state.offset === 0}
                    onClick={() => {
                      if (state.offset > 0) setState({ ...state, offset: state.offset - PAGE_SIZE });
                    }}
                  >
                    Previous vendors
                  </button>{" "}
                  <button
                    type="button"
                    className="action"
                    aria-disabled={state.offset + PAGE_SIZE >= matching.length}
                    onClick={() => {
                      if (state.offset + PAGE_SIZE < matching.length)
                        setState({ ...state, offset: state.offset + PAGE_SIZE });
                    }}
                  >
                    Next vendors
                  </button>
                </fieldset>
                <ol>
                  {matching.slice(state.offset, state.offset + PAGE_SIZE).map((row, index) => (
                    <li data-vendor-id={row.subject_id} key={`${row.subject_id}-${row.ref}`}>
                      <a
                        id={`quiet-vendor-${index}`}
                        href={options.href(row.subject_id)}
                        onClick={(event) => {
                          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                            return;
                          event.preventDefault();
                          options.open(event.currentTarget.href, event.currentTarget.id);
                        }}
                      >
                        {row.name || row.ref}
                      </a>
                      <p>
                        <span className="quiet-vendor-detail">
                          {row.basis === "created_at" ? "Never contacted · Created" : "Last contact"}{" "}
                          <time dateTime={row.anchor_on}>{row.anchor_on}</time>
                        </span>
                        {" · "}
                        <span className="quiet-vendor-detail">
                          Due <time dateTime={row.due_on}>{row.due_on}</time>
                        </span>
                        {" · "}
                        <span className="quiet-vendor-detail">
                          {row.days_overdue === 0
                            ? "Due today"
                            : `${row.days_overdue} ${row.days_overdue === 1 ? "day" : "days"} overdue`}
                        </span>
                        {" · Owner: "}
                        {row.owner == null ? "not recorded" : ownerLabel(row.owner)}
                      </p>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
export function mountQuietVendors(host: HTMLElement, options: Options) {
  const root = createRoot(host);
  const lifetime: Lifetime = { disposed: false, reading: false };
  const render = () => root.render(<QuietVendors options={options} lifetime={lifetime} />);
  flushSync(render);
  return {
    update() {
      flushSync(render);
    },
    dispose() {
      lifetime.disposed = true;
      flushSync(() => root.unmount());
    },
  };
}
