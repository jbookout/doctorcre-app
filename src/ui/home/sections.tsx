import { Component, type ReactNode, useState, useSyncExternalStore } from "react";
import { pageScroller } from "../../../js/touch-layout.js";
import type { HomeTileName, InboxItem } from "./inbox";

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const completionFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
export const day = (date: Date) => dayFormat.format(date);

export function lateDays(due: string | null, today: string) {
  return due && due < today ? (Date.parse(today) - Date.parse(due)) / 86_400_000 : 0;
}

export function completionLabel(item: InboxItem) {
  if (!item.completed_at) return "Done, time not recorded";
  const label = item.engine_marks && item.kind_label === "Reply draft" ? "Sent" : "Done";
  return `${label} ${completionFormat.format(new Date(item.completed_at))}`;
}

export const tilePreviewCount = 5;
// A stacked list tile on a phone previews this many rows above See all.
const phonePreviewCount = 4;
export const cardKey = (item: InboxItem) => item.card_id ?? item.item_id;
const waitingSections: readonly InboxItem["section"][] = ["working", "held", "snoozed"];

/** Whether why only repeats the reminder's heading, or expands a heading cut with "…". */
export function repeatsTitle(title: string, why: string | undefined) {
  if (!why) return false;
  const cut = title.endsWith("…") && why.startsWith(title.slice(0, -1).trimEnd());
  return cut || why === title;
}

export function tileOf(item: InboxItem): HomeTileName {
  if (item.dashboard_tile) return item.dashboard_tile;
  if (waitingSections.includes(item.section)) return "waiting";
  return item.action_id && item.presentation?.primaryAction !== "Review completion" ? "reminders" : "inbox";
}

export function dashboardCards(items: readonly InboxItem[], today = day(new Date())) {
  const tiles: Record<HomeTileName, InboxItem[]> = { reminders: [], inbox: [], waiting: [] };
  for (const item of items) {
    if (!item.dashboard_tile) {
      if (item.auto_settled || item.source_state === "done") continue;
      const lead = !item.deal_id && /^\/(?:leads(?:[/?#]|$)|deals\?[^#]*\bprospect=)/.test(item.open_url ?? "");
      if (item.action_id && lead) continue;
      const due = !item.action_id || !item.due_on || item.due_on <= today;
      if (item.section === "inbox" ? !due : !waitingSections.includes(item.section)) continue;
    }
    tiles[tileOf(item)].push(item);
  }
  return tiles;
}

const groups = ["Late", "Today", "No date", "folded"] as const;
type ReminderGroup = (typeof groups)[number];
// Reminders 15 or more days late fold into one line under the rest.
function reminderGroup(item: InboxItem): ReminderGroup {
  const late = item.days_late ?? 0;
  if (late >= 15) return "folded";
  if (late) return "Late";
  return item.due_on ? "Today" : "No date";
}
const byGroup = (a: InboxItem, b: InboxItem) =>
  groups.indexOf(reminderGroup(a)) - groups.indexOf(reminderGroup(b)) || (b.days_late ?? 0) - (a.days_late ?? 0);

/** Below three columns Home is one scrolling page. The stylesheet decides by Home's own width, which the walkthrough can narrow. */
export function useStacked() {
  return useSyncExternalStore(
    (change) => {
      const observer = new ResizeObserver(change);
      observer.observe(document.body);
      return () => observer.disconnect();
    },
    () => {
      const grid = document.querySelector(".home-sections");
      // Before the grid is drawn, the window is the best guess: without the walkthrough the two agree.
      return grid ? getComputedStyle(grid).flexDirection === "column" : matchMedia("(max-width: 999px)").matches;
    },
  );
}

export function HomeTile({
  title,
  count,
  detail,
  children,
  expanded,
  setExpanded,
  preview = tilePreviewCount,
}: {
  title: string;
  count: number;
  detail?: string | undefined;
  children: ReactNode;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  preview?: number;
}) {
  return (
    <section className="home-slice" aria-label={title}>
      <header>
        <h2 tabIndex={-1}>
          {title} <span>{detail ? `${count} · ${detail}` : count}</span>
        </h2>
        {count > preview && (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : `See all ${count}`}
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

/** A tile's shape while its read is in flight: a title bar and three card rows. */
export function PlaceholderTile() {
  return (
    <div className="home-slice home-placeholder" aria-hidden="true">
      <header>
        <span className="skeleton-line short" />
      </header>
      {[0, 1, 2].map((row) => (
        <div className="home-placeholder-row" key={row}>
          <span className="skeleton-line" />
          <span className="skeleton-line short" />
        </div>
      ))}
    </div>
  );
}

function retainOrder(previous: readonly InboxItem[], incoming: readonly InboxItem[]) {
  const remaining = new Map(incoming.map((item) => [cardKey(item), item]));
  return [
    ...previous.flatMap((old) => {
      const current = remaining.get(cardKey(old));
      remaining.delete(cardKey(old));
      return current ? [current] : [];
    }),
    ...remaining.values(),
  ];
}

/** A tile's rows as drawn: a refresh keeps their relative order, new rows join the end, and the open item keeps its place after it leaves. */
export function useTileRows(items: readonly InboxItem[], pinned: InboxItem | null, grouped = false) {
  const [order, setOrder] = useState({ incoming: items, pinned, cards: items });
  const changed = order.incoming !== items || order.pinned !== pinned;
  const preserve = pinned && !items.some((item) => cardKey(item) === cardKey(pinned));
  const visible = changed ? retainOrder(order.cards, preserve ? [...items, pinned] : items) : order.cards;
  if (changed) setOrder({ incoming: items, pinned, cards: visible });
  return grouped ? [...visible].sort(byGroup) : visible;
}

export function CardTile({
  title,
  rows,
  count: live,
  pinned,
  current,
  row,
  after = [],
  grouped = false,
}: {
  title: string;
  /** From useTileRows. */
  rows: readonly InboxItem[];
  count: number;
  pinned?: InboxItem | null;
  current: string | undefined;
  row: (item: InboxItem) => ReactNode;
  after?: ReactNode[];
  grouped?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const isStacked = useStacked();
  const preview = isStacked ? phonePreviewCount : Number.POSITIVE_INFINITY;
  const count = live + after.length;
  if (!rows.length && !after.length) return null;
  const kept = (item: InboxItem) => item.item_id === current || (pinned && cardKey(item) === cardKey(pinned));
  const shown = expanded ? rows : rows.filter((item, index) => index < preview || kept(item));
  const inGroup = (group: ReminderGroup) => shown.filter((item) => grouped && reminderGroup(item) === group);
  const folded = inGroup("folded");
  const late = rows.filter((item) => grouped && reminderGroup(item) === "Late").length;
  return (
    <HomeTile
      title={title}
      count={count}
      detail={late ? `${late} late` : undefined}
      expanded={expanded}
      setExpanded={setExpanded}
      preview={preview}
    >
      {grouped
        ? groups.slice(0, 3).map((group) => {
            const rows = inGroup(group);
            return (
              rows.length > 0 && (
                <section key={group} aria-label={group}>
                  <h3 className={group === "Late" ? "home-group home-late" : "home-group"}>{group}</h3>
                  {rows.map(row)}
                </section>
              )
            );
          })
        : shown.map(row)}
      {folded.length > 0 &&
        (unfolded || folded.some(kept) ? (
          <section aria-label="More than two weeks late">
            <h3 className="home-group home-late">More than two weeks late</h3>
            {folded.map(row)}
          </section>
        ) : (
          <button type="button" className="home-fold" onClick={() => setUnfolded(true)}>
            {folded.length} more than two weeks late
          </button>
        ))}
      {expanded ? after : after.slice(0, Math.max(0, preview - live))}
    </HomeTile>
  );
}

type Anchor = { node: Element; top: number };

function revealColumnFocus(column: HTMLElement, control: HTMLElement) {
  if (column.scrollHeight <= column.clientHeight || !control.matches(":focus-visible")) return;

  const { top, bottom } = control.getBoundingClientRect();
  const edge = column.getBoundingClientRect().top + column.clientTop;
  const style = getComputedStyle(control);
  const ring =
    style.outlineStyle === "none" ? 0 : Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
  const above = top - ring - edge;
  const below = bottom + ring - (edge + column.clientHeight);
  if (above < 0) column.scrollTop += Math.floor(above);
  else if (below > 0) column.scrollTop += Math.ceil(below);
}

function homePreview(group: HTMLElement): HTMLElement[] {
  const preview: HTMLElement[] = [];
  for (const child of group.children) {
    if (!(child instanceof HTMLElement) || !child.offsetHeight || child.matches("header, h2, h3, hr")) continue;
    if (group.hasAttribute("data-open") && child.matches(".home-short-fold-line")) continue;
    const rows = child.matches("section, ul, ol") ? homePreview(child) : [child];
    preview.push(...(rows.length ? rows : [child]));
    if (!preview.at(-1)?.matches('[role="status"]')) break;
  }
  return preview;
}

function fitHomeTiles(grid: HTMLDivElement) {
  const watched = new Set<Element>([grid]);
  const openFolds = new WeakSet<HTMLElement>();
  const fonts = grid.ownerDocument.fonts;
  let frame = 0;
  let focusFrame = 0;
  let active = true;
  const resize = new ResizeObserver(schedule);
  const mutations = new MutationObserver(() => {
    cancelAnimationFrame(frame);
    fit();
  });

  function fit() {
    frame = 0;
    const next = new Set<Element>([grid]);
    const sizes =
      getComputedStyle(grid).flexDirection === "row"
        ? Array.from(grid.querySelectorAll<HTMLElement>(":scope > .home-column > .home-slice"), (tile) => {
            const header = tile.querySelector<HTMLElement>(":scope > header");
            const fold = tile.querySelector<HTMLElement>(":scope > [data-home-fold]");
            const control = fold?.querySelector<HTMLButtonElement>(":scope > button");
            const open = control?.offsetHeight && fold?.hasAttribute("data-open") ? fold : null;
            const preview = homePreview(open ?? tile);
            const last = preview.at(-1);

            const css = getComputedStyle(tile);
            const paddingStart = Number.parseFloat(css.paddingBlockStart);
            const paddingEnd = Number.parseFloat(css.paddingBlockEnd);
            // Sticky controls can cover the tile padding as well as the rows.
            const stickyStart = header?.offsetHeight
              ? paddingStart + header.offsetHeight + Number.parseFloat(getComputedStyle(header).top)
              : 0;
            const footerHeight = open ? 0 : (control?.getBoundingClientRect().height ?? 0);
            const stickyEnd = footerHeight ? footerHeight + paddingEnd : 0;
            const targets = footerHeight
              ? Array.from(tile.querySelectorAll<HTMLElement>("a[href], button, summary")).filter(
                  (target) => target.offsetHeight && !header?.contains(target) && !fold?.contains(target),
                )
              : [];
            for (const node of [header, control, ...preview, ...targets]) if (node) next.add(node);

            const targetHeight = Math.max(
              0,
              ...Array.from(targets, (target) => {
                const style = getComputedStyle(target);
                return (
                  target.getBoundingClientRect().height +
                  Number.parseFloat(style.scrollMarginBlockStart) +
                  Number.parseFloat(style.scrollMarginBlockEnd)
                );
              }),
            );
            // An open fold can scroll past the phases, but its first result and control fit together.
            const previewStart = open
              ? open.getBoundingClientRect().top - stickyStart
              : tile.getBoundingClientRect().top - tile.scrollTop;
            const minimum = last
              ? Math.ceil(
                  Math.max(last.getBoundingClientRect().bottom - previewStart, stickyStart + targetHeight) +
                    paddingEnd +
                    footerHeight,
                )
              : null;
            const reveal = last && open && !openFolds.has(open) ? open : null;
            if (fold) {
              if (last && open) openFolds.add(open);
              else openFolds.delete(fold);
            }
            return { tile, minimum, stickyStart, stickyEnd, reveal };
          })
        : [];
    for (const node of watched) {
      if (next.has(node)) continue;
      resize.unobserve(node);
      watched.delete(node);
    }
    for (const node of next) {
      if (watched.has(node)) continue;
      resize.observe(node);
      watched.add(node);
    }
    for (const { tile, minimum, stickyStart, stickyEnd } of sizes) {
      for (const [property, value] of [
        ["--home-preview-size", minimum],
        ["--home-sticky-start", stickyStart],
        ["--home-sticky-end", stickyEnd],
      ] as const) {
        const pixels = value === null ? "" : `${value}px`;
        if (tile.style.getPropertyValue(property) !== pixels) tile.style.setProperty(property, pixels);
      }
    }
    for (const { tile, minimum, stickyStart, stickyEnd, reveal } of sizes) {
      tile.toggleAttribute(
        "data-home-fitted",
        minimum !== null && stickyEnd > 0 && tile.getBoundingClientRect().height >= minimum,
      );
      if (reveal) {
        tile.scrollTop += reveal.getBoundingClientRect().top - tile.getBoundingClientRect().top - stickyStart;
        tile.scrollIntoView({ block: "nearest", behavior: "instant" });
      }
    }
  }

  function schedule() {
    // eslint-disable-next-line no-restricted-syntax -- At most one pending frame to fit the visible tiles, canceled on unmount.
    if (active && !frame) frame = requestAnimationFrame(fit);
  }

  function onFocus(event: FocusEvent) {
    const control = event.target;
    if (!(control instanceof HTMLElement) || control.closest(".home-inline-review")) return;
    const column = control.closest<HTMLElement>(".home-column");
    if (column?.parentElement !== grid) return;
    cancelAnimationFrame(focusFrame);
    // eslint-disable-next-line no-restricted-syntax -- One frame after native focus scrolling, canceled on unmount.
    focusFrame = requestAnimationFrame(() => {
      if (grid.ownerDocument.activeElement === control) revealColumnFocus(column, control);
    });
  }

  resize.observe(grid);
  mutations.observe(grid, { childList: true, subtree: true, characterData: true, attributeFilter: ["data-open"] });
  grid.addEventListener("focusin", onFocus);
  fonts.addEventListener("loadingdone", schedule);
  void fonts.ready.then(schedule);
  fit();
  return () => {
    active = false;
    resize.disconnect();
    mutations.disconnect();
    grid.removeEventListener("focusin", onFocus);
    fonts.removeEventListener("loadingdone", schedule);
    cancelAnimationFrame(frame);
    cancelAnimationFrame(focusFrame);
  };
}

export class HomeGrid extends Component<{ children: ReactNode; snapshot: unknown; calendar?: unknown }> {
  private grid: HTMLDivElement | null = null;
  private stopFitting: (() => void) | undefined;

  componentDidMount() {
    if (this.grid) this.stopFitting = fitHomeTiles(this.grid);
  }

  componentWillUnmount() {
    this.stopFitting?.();
  }

  getSnapshotBeforeUpdate(previous: Readonly<typeof this.props>): Anchor[] | null {
    if (
      !pageScroller().scrollTop ||
      (this.props.snapshot === previous.snapshot && this.props.calendar === previous.calendar)
    )
      return null;
    const active = document.activeElement;
    if (active && this.grid?.contains(active)) return [{ node: active, top: active.getBoundingClientRect().top }];
    return Array.from(this.grid?.querySelectorAll(".inbox-row, .home-today-row") ?? []).flatMap((node) => {
      const { top, bottom } = node.getBoundingClientRect();
      return bottom > 0 && top < window.innerHeight ? [{ node, top }] : [];
    });
  }

  componentDidUpdate(_previous: Readonly<typeof this.props>, _state: unknown, anchors: Anchor[] | null) {
    const anchor = anchors?.find(({ node }) => node.isConnected);
    if (anchor)
      pageScroller().scrollBy({ top: anchor.node.getBoundingClientRect().top - anchor.top, behavior: "instant" });
  }

  render() {
    return (
      <div
        className="home-sections"
        ref={(node) => {
          this.grid = node;
        }}
      >
        {this.props.children}
      </div>
    );
  }
}
