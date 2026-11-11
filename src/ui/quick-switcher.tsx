import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { fixtureInboxRpc } from "./home/fixture";
import { createInboxClient, parseSnapshot } from "./home/inbox";
import { recordRoutes } from "./home/routes";
import { isTextEntry } from "./keyboard-input";
import { clearRecents, recentIds, rememberDestination as remember } from "./switcher-history";

type Destination = { id: string; label: string; kind: "Deal" | "Contact" | "Task" | "Page"; href: string };
type Availability = "full" | "board" | "contacts" | "none";
type ReadState =
  | { kind: "loading" }
  | { kind: "ready"; items: Destination[]; availability: Availability; inboxNotice: string }
  | { kind: "error" };
type Options = {
  opener: HTMLElement;
  pages: { label: string; href: string }[];
  read: () => Promise<{ board: unknown; network: unknown; inbox: unknown }>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function boardDestinations(board: unknown): Destination[] {
  if (!record(board) || !Array.isArray(board.deals)) throw Error("Invalid board");
  const result: Destination[] = [];
  const seen = new Set<string>();
  const deals = [...board.deals];
  for (const key of ["closed_deals", "lost_deals"]) {
    if (board[key] === undefined) continue;
    if (!Array.isArray(board[key])) throw Error("Invalid deals");
    deals.push(...board[key]);
  }
  for (const deal of deals) {
    if (!record(deal) || !text(deal.id) || !text(deal.name)) throw Error("Invalid deal");
    if (
      deal.open_actions !== undefined &&
      (!Array.isArray(deal.open_actions) ||
        deal.open_actions.some(
          (action) => !record(action) || !text(action.id) || !text(action.item_id) || !text(action.description),
        ))
    )
      throw Error("Invalid tasks");
    if (seen.has(deal.id)) continue;
    seen.add(deal.id);
    const href = `/deals?deal=${encodeURIComponent(deal.id)}`;
    result.push({ id: `deal:${deal.id}`, label: deal.name, kind: "Deal", href });
    if (Array.isArray(deal.open_actions))
      for (const action of deal.open_actions) {
        if (record(action) && text(action.item_id) && text(action.description))
          result.push({
            id: `task:${action.item_id}`,
            label: `${action.description} · ${deal.name}`,
            kind: "Task",
            href: recordRoutes.card(action.item_id),
          });
      }
  }
  return result;
}

function contactDestinations(network: unknown): Destination[] {
  if (!record(network) || !Array.isArray(network.nodes)) throw Error("Invalid contacts");
  const result: Destination[] = [];
  for (const node of network.nodes) {
    if (
      !record(node) ||
      !text(node.id) ||
      !text(node.name) ||
      !["vendor", "client", "lead", "contact", "deal"].includes(String(node.kind))
    )
      throw Error("Invalid contact");
    if (node.kind === "deal" || node.contact_state === "retired") continue;
    result.push({
      id: node.id,
      label: node.name,
      kind: "Contact",
      href: `/relationships?node=${encodeURIComponent(node.id)}`,
    });
  }
  return result;
}

function admittedSection(parse: () => Destination[]): Destination[] | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

function destinations({
  board,
  network,
  inbox,
}: {
  board: unknown;
  network: unknown;
  inbox: unknown;
}): Extract<ReadState, { kind: "ready" }> {
  const deals = admittedSection(() => boardDestinations(board));
  const contacts = admittedSection(() => contactDestinations(network));
  let inboxNotice = "";
  const tasks = admittedSection(() => {
    const snapshot = parseSnapshot(inbox);
    if (snapshot.truncated) inboxNotice = "Home task snapshot is limited to 1,000 items. Some tasks may be absent.";
    return snapshot.items
      .filter((item) => item.source_type === "next_action" || item.source_type === "capture_post_call_action")
      .map((item) => ({
        id: `task:${item.item_id}`,
        label: item.context_label ? `${item.title} · ${item.context_label}` : item.title,
        kind: "Task" as const,
        href: recordRoutes.card(item.item_id),
      }));
  });
  if (tasks === null) inboxNotice = "Home tasks unavailable. Other accessible results are still available.";
  const items = new Map([...(deals ?? []), ...(contacts ?? []), ...(tasks ?? [])].map((item) => [item.id, item]));
  return {
    kind: "ready",
    inboxNotice,
    items: [...items.values()],
    availability: deals !== null ? (contacts !== null ? "full" : "board") : contacts !== null ? "contacts" : "none",
  };
}

const unavailableMessage = {
  full: "",
  board: "Contacts unavailable. Deals, tasks and pages are still available.",
  contacts: "Deals unavailable. Contacts and pages are still available.",
  none: "Deals and contacts unavailable. Pages are still available.",
};

export async function readQuickSwitcherSources(
  readBoard: () => Promise<unknown>,
  readNetwork: () => Promise<unknown>,
  readInbox: () => Promise<unknown>,
): Promise<{ board: unknown; network: unknown; inbox: unknown }> {
  const [board, network, inbox] = await Promise.allSettled([
    Promise.resolve().then(readBoard),
    Promise.resolve().then(readNetwork),
    Promise.resolve().then(readInbox),
  ]);
  return {
    board: board.status === "fulfilled" ? board.value : null,
    network: network.status === "fulfilled" ? network.value : null,
    inbox: inbox.status === "fulfilled" ? inbox.value : null,
  };
}

export function switcherInboxReader(
  request: (
    name: string,
    args: unknown,
    options: { timeoutMs: number },
  ) => Promise<{ kind: string; isError?: boolean; payload?: unknown }>,
  fixture: boolean,
) {
  return createInboxClient(
    fixture
      ? fixtureInboxRpc()
      : async (name, args) => {
          const result = await request(name, args, { timeoutMs: 10000 });
          if (result.kind !== "payload") throw Error("Inbox transport unavailable");
          if (result.isError) throw Object.assign(Error("Inbox refused"), { payload: result.payload });
          return result.payload;
        },
  ).read;
}

export function openQuickSwitcher({ opener, pages, read }: Options) {
  if (document.querySelector("[data-quick-switcher]")) return;
  const dialog = document.createElement("dialog");
  dialog.dataset.quickSwitcher = "";
  dialog.className = "quick-switcher";
  dialog.setAttribute("aria-label", "Quick switcher");
  document.body.append(dialog);
  const root = createRoot(dialog);
  let retired = false;
  const close = () => {
    if (retired) return;
    retired = true;
    dialog.close();
    root.unmount();
    dialog.remove();
    window.removeEventListener("doctorcre-session-invalidated", revoke);
    opener.focus();
  };
  const revoke = () => {
    clearRecents();
    close();
  };
  window.addEventListener("doctorcre-session-invalidated", revoke, { once: true });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        close();
    }
  });
  root.render(<Switcher pages={pages} read={read} close={close} />);
  dialog.showModal();
}

function Switcher({ pages, read, close }: Omit<Options, "opener"> & { close: () => void }) {
  const [state, setState] = useState<ReadState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Destination["kind"] | "All">("All");
  const [active, setActive] = useState(0);
  const [request, setRequest] = useState({ read });
  const input = useRef<HTMLInputElement>(null);
  const pageItems = useMemo<Destination[]>(
    () => pages.map((page) => ({ ...page, id: `page:${page.href}`, kind: "Page" })),
    [pages],
  );
  const all = [...(state.kind === "ready" ? state.items : []), ...pageItems];
  const normalized = query.trim().toLocaleLowerCase();
  const recents = recentIds().flatMap((id) => all.find((item) => item.id === id) || []);
  const candidates =
    normalized || kind !== "All"
      ? all
      : [...recents, ...pageItems.filter((page) => !recents.some((item) => item.id === page.id))];
  const results = candidates.filter(
    (item) =>
      (kind === "All" || item.kind === kind) &&
      (!normalized || `${item.label} ${item.kind}`.toLocaleLowerCase().includes(normalized)),
  );
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));
  const selected = results[activeIndex];
  const unavailable =
    state.kind === "error"
      ? unavailableMessage.none
      : state.kind === "ready"
        ? unavailableMessage[state.availability]
        : "";
  const inboxNotice = state.kind === "ready" ? state.inboxNotice : "";
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    setActive(0);
    void request
      .read()
      .then((payload) => {
        if (current) {
          const admitted = destinations(payload);
          const items = admitted.items;
          const path = `${location.pathname}${location.search}`;
          const opened = [...items, ...pageItems].find((item) => item.href === path);
          if (opened) remember(opened.id);
          setActive(0);
          setState(admitted);
        }
      })
      .catch(() => {
        if (current) setState({ kind: "error" });
      });
    return () => {
      current = false;
    };
  }, [request, pageItems]);
  useEffect(() => {
    document.getElementById(`quick-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  const navigate = (item: Destination) => {
    remember(item.id);
    close();
    location.assign(item.href);
  };
  return (
    <div className="quick-switcher-content">
      <header>
        <h2>Jump to</h2>
        <button type="button" aria-label="Close quick switcher" onClick={close}>
          Close
        </button>
      </header>
      <input
        ref={input}
        id="quick-input"
        role="combobox"
        aria-label="Jump to"
        autoComplete="off"
        placeholder="Deals, contacts, tasks and pages"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls="quick-results"
        aria-activedescendant={selected ? `quick-option-${activeIndex}` : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (isTextEntry(event.nativeEvent)) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (results.length)
              setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
          } else if (event.key === "Enter" && selected) {
            event.preventDefault();
            navigate(selected);
          }
        }}
      />
      <fieldset
        aria-label="Destination kind"
        style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", border: 0, padding: 0, margin: 0 }}
      >
        {(["All", "Deal", "Contact", "Task", "Page"] satisfies (Destination["kind"] | "All")[]).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={kind === value}
            onClick={() => {
              setKind(value);
              setActive(0);
            }}
          >
            {value === "All" ? "All destinations" : `${value}s`}
          </button>
        ))}
      </fieldset>
      <p role="status">
        {state.kind === "loading"
          ? "Loading accessible items…"
          : unavailable
            ? unavailable
            : `${results.length} destinations`}
      </p>
      {inboxNotice && <p role="status">{inboxNotice}</p>}
      <p>Searches loaded deals, contacts and up to 1,000 Home items.</p>
      {unavailable && <p>{results.length} destinations</p>}
      {state.kind !== "loading" && results.length === 0 && <p>No matches. Try a deal, contact or page name.</p>}
      {(unavailable || inboxNotice) && (
        <button type="button" onClick={() => setRequest({ read })}>
          Retry
        </button>
      )}
      {!normalized && kind === "All" && <h3>{recents.length ? "Recent" : "Pages"}</h3>}
      <div id="quick-results" role="listbox" aria-label="Destinations">
        {results.map((item, index) => (
          <div
            key={item.id}
            id={`quick-option-${index}`}
            role="option"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !isTextEntry(event.nativeEvent)) navigate(item);
            }}
            aria-selected={index === activeIndex}
            onPointerMove={() => setActive(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => navigate(item)}
          >
            <span>{item.label}</span>
            <small>{item.kind}</small>
          </div>
        ))}
      </div>
      <footer>↑ ↓ to move · Enter to open · Esc to close</footer>
    </div>
  );
}
