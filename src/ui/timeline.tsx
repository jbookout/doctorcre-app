import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  arrowPath,
  DAY_WIDTH,
  dayOf,
  labelLayout,
  MIN_BAR_WIDTH,
  scale,
  shortDate,
  spanBox,
  spentWidth,
  weekdayDate,
  yearOf,
  ZOOMS,
  type Zoom,
} from "./timeline-scale.ts";

export type TimelinePhase =
  | "pending"
  | "research"
  | "site_selection"
  | "negotiation"
  | "legal"
  | "due_diligence"
  | "closing"
  | "closed";

export type TimelinePartner = "Dell" | "Joe";

interface TimelineRowBase {
  id: string;
  name: string;
  phase: TimelinePhase;
  when?: string | undefined;
  note?: string;
}

export type TimelineTodo = TimelineRowBase &
  (
    | { kind: "todo"; state: "done"; start: string; end: string }
    | {
        kind: "todo";
        state: "current";
        start: string;
        end: string;
        progress?: string | undefined;
        overTypical?: boolean;
        atRisk?: boolean | undefined;
      }
    | {
        kind: "todo";
        state: "expected";
        start: string;
        end: string;
        length?: string | undefined;
        atRisk?: boolean | undefined;
      }
    | { kind: "todo"; state: "stale"; start: string }
    | { kind: "todo"; state: "unrecorded" }
    | { kind: "todo"; state: "waiting" }
  );

export type TimelineStep = TimelineRowBase & { kind: "step"; owner: TimelinePartner; start: string } & (
    | { state: "done"; end: string }
    | { state: "open"; due: string }
    | { state: "undated" }
  );

export type TimelineDate = TimelineRowBase & {
  kind: "date";
  day: string;
  state: "confirmed" | "proposed" | "expected";
  atRisk?: boolean | undefined;
  detail?: string | undefined;
};

export type TimelineRow = TimelineTodo | TimelineStep | TimelineDate;
export interface TimelinePhaseBar {
  phase: TimelinePhase;
  start: string;
  end: string;
}

export interface TimelineGroup {
  id: string;
  name: string;
  count?: string;
  done?: boolean;
  bar?: TimelinePhaseBar | undefined;
  bars?: readonly TimelinePhaseBar[];
  href?: string;
  attention?: string | undefined;
  owner?: TimelinePartner | undefined;
  signing?: { day: string; recorded: boolean } | undefined;
  startsFolded: boolean;
  rows: readonly TimelineRow[];
}

export type TimelineLink =
  | { kind: "workflow"; from: string; to: string }
  | { kind: "deadline"; from: string; to: string; atRisk?: boolean | undefined };

export interface TimelineProps {
  // Folds are remembered per chart, so a deal's plan and Deals Timeline keep their own.
  foldKey: string;
  today: string;
  from: string;
  to: string;
  groups: readonly TimelineGroup[];
  links?: readonly TimelineLink[];
}

type TimelineViewProps = TimelineProps & {
  controls?: ReactNode;
  toolsHost?: HTMLElement | undefined;
  board?: boolean;
  reveal?: { group: string; row?: string | undefined; day: string } | undefined;
  onOpen?: (id: string) => void;
};

type Folds = Record<string, boolean>;
type Tone = "default" | "late" | "soon";
type Measure = (text: string) => number;

const ZOOM_LABEL: Record<Zoom, string> = { day: "Day", week: "Week", month: "Month" };
const rowId = (uid: string, row: TimelineRow) => `${uid}-${row.id}`;
const foldStorage = (key: string) => `doctorcre.timeline-folds.${key}`;
const isNearDay = (day: number, now: number) => day >= now && day <= now + 7;
const optTone = (tone: Tone) => (tone === "default" ? undefined : tone);

function readFolds(key: string): Folds {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(foldStorage(key)) ?? "{}");
    if (!saved || typeof saved !== "object") return {};
    return Object.fromEntries(Object.entries(saved).filter(([, folded]) => typeof folded === "boolean"));
  } catch {
    return {};
  }
}

function writeFolds(key: string, folds: Folds) {
  try {
    localStorage.setItem(foldStorage(key), JSON.stringify(folds));
  } catch {
    // A private window keeps the fold for this visit only.
  }
}

// How much of the dates is in view beside the sticky list column.
const visibleTrack = (scroller: HTMLElement | null, corner: HTMLElement | null) =>
  (scroller?.clientWidth ?? 0) - (corner?.offsetWidth ?? 0);

// Half the widest date label, so a label only touches the Today pill when its text would.
const DATE_LABEL_HALF = 12;
const BESIDE_LABELS = '.timeline-bar[data-label-pos="beside"] .timeline-bar-name, .timeline-diamond-label';
const CHECK_WIDTH = 12;
const UNDATED_MIN_WIDTH = 60;
const UNDATED_TAIL_DAYS = 4;
const DEFAULT_ROW_HEIGHT = 34;
const DIAMOND_HALF = 8.5;
const BESIDE_CUTOUT_OFFSET = 13;
const DIAMOND_LABEL_OFFSET = 13;
const DIAMOND_DETAIL_GAP = 8;
const CUTOUT_PAD_Y = 6;
const TIP_LEFT_GAP = 4;
const TIP_RIGHT_GAP = 8;
const TIP_OFFSET = 6;

// Marks the chart while it is being scrolled, so the scrollbar can show only then.
function useScrollCue(scroller: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const start = () => {
      node.dataset.scrolling = "";
    };
    const end = () => delete node.dataset.scrolling;
    node.addEventListener("scroll", start, { passive: true });
    node.addEventListener("scrollend", end);
    return () => {
      node.removeEventListener("scroll", start);
      node.removeEventListener("scrollend", end);
    };
  }, [scroller]);
}

// A label beside a mark that starts under the list column would show only its tail, so it hides until its first letter is clear of the list.
function useCoveredLabels(scroller: RefObject<HTMLElement | null>, corner: RefObject<HTMLElement | null>) {
  const cover = useCallback(() => {
    const edge = (corner.current?.getBoundingClientRect().right ?? 0) + 1;
    for (const label of scroller.current?.querySelectorAll<HTMLElement>(BESIDE_LABELS) ?? []) {
      const textStart = label.getBoundingClientRect().left + parseFloat(getComputedStyle(label).paddingLeft);
      if (textStart < edge) label.dataset.covered = "";
      else delete label.dataset.covered;
    }
  }, [scroller, corner]);

  useLayoutEffect(cover);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    node.addEventListener("scroll", cover, { passive: true });
    return () => node.removeEventListener("scroll", cover);
  }, [scroller, cover]);
}

// Clamps the hover note to its rendered box inside the visible track, wrapping when the track is narrow.
function useTipPosition(
  tip: RefObject<HTMLDivElement | null>,
  scroller: RefObject<HTMLElement | null>,
  corner: RefObject<HTMLElement | null>,
  hoveredBox: RowBox | undefined,
  rowHeight: number,
  note: NoteContent | undefined,
  font: string,
) {
  const hoveredRowId = hoveredBox?.row.id;
  const anchorLeft = hoveredBox?.left;
  const rowTop = hoveredBox?.rowTop;
  const tipKey = note ? `${note.title}\n${note.dates}\n${note.source}\n${font}` : "";

  const position = useCallback(() => {
    const tipNode = tip.current;
    const scrollNode = scroller.current;
    if (!tipNode || !scrollNode || anchorLeft === undefined || rowTop === undefined) return;
    const trackWidth = visibleTrack(scrollNode, corner.current);
    if (trackWidth <= 0) return;
    const maxWidth = Math.max(1, trackWidth - TIP_LEFT_GAP - TIP_RIGHT_GAP);
    tipNode.style.left = "0px";
    tipNode.style.maxWidth = `${maxWidth}px`;
    const { width: tipWidth, height: tipHeight } = tipNode.getBoundingClientRect();
    const scrollLeft = scrollNode.scrollLeft;
    const minLeft = scrollLeft + TIP_LEFT_GAP;
    const maxLeft = Math.max(minLeft, scrollLeft + trackWidth - Math.ceil(tipWidth) - TIP_RIGHT_GAP);
    const left = Math.min(Math.max(anchorLeft, minLeft), maxLeft);
    const place = rowTop - scrollNode.scrollTop < tipHeight + TIP_OFFSET + 4 ? "below" : "above";
    tipNode.dataset.place = place;
    tipNode.style.left = `calc(var(--list) + ${left}px)`;
    tipNode.style.top = `${place === "above" ? rowTop - TIP_OFFSET : rowTop + rowHeight + TIP_OFFSET}px`;
  }, [tip, scroller, corner, anchorLeft, rowTop, rowHeight]);

  useLayoutEffect(() => {
    if (!hoveredRowId || !tipKey) return;
    position();
  }, [hoveredRowId, tipKey, position]);

  useEffect(() => {
    if (!hoveredRowId) return;
    const scrollNode = scroller.current;
    scrollNode?.addEventListener("scroll", position, { passive: true });
    window.addEventListener("resize", position);
    return () => {
      scrollNode?.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
    };
  }, [hoveredRowId, scroller, position]);
}

function textMeasurer(font: string): Measure {
  const context = document.createElement("canvas").getContext("2d");
  if (!context || !font) return () => 0;
  context.font = font;
  return (text) => context.measureText(text).width;
}

const CheckIcon = ({ size, className }: { size: number; className?: string }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

function RowGlyph({ row }: { row: TimelineRow }) {
  if (row.kind === "step") {
    return (
      <span className="timeline-owner" role="img" aria-label={row.owner}>
        {row.owner[0]}
      </span>
    );
  }
  const inner =
    row.kind === "date" ? (
      <i className="timeline-glyph-diamond" data-phase={row.phase} data-state={row.state} />
    ) : row.state === "done" ? (
      <CheckIcon size={14} className="timeline-glyph-check" />
    ) : (
      <i
        className="timeline-glyph-ring"
        data-ring={row.state === "current" || row.state === "stale" ? "current" : "dashed"}
      />
    );
  return (
    <span className="timeline-glyph" aria-hidden="true">
      {inner}
    </span>
  );
}

interface RowMeta {
  when: string | undefined;
  tone: Tone;
  alert?: string;
  quiet: boolean;
  lateDays: number;
}

const dateTone = (row: TimelineDate, now: number): Tone =>
  row.atRisk ? "late" : row.state !== "expected" && isNearDay(dayOf(row.day), now) ? "soon" : "default";

// Lateness and tone are worked out here once per row, for both its list label and its mark.
function rowMeta(row: TimelineRow, now: number): RowMeta {
  if (row.kind === "step") {
    if (row.state === "done") return { when: row.when, tone: "default", quiet: true, lateDays: 0 };
    if (row.state === "undated") return { when: row.when ?? "No date", tone: "default", quiet: false, lateDays: 0 };
    const lateDays = Math.max(0, now - dayOf(row.due));
    const late = lateDays > 0;
    return {
      when: row.when,
      tone: late ? "late" : "default",
      ...(late && { alert: "Late step" }),
      quiet: false,
      lateDays,
    };
  }
  if (row.kind === "date") {
    return {
      when: row.when,
      tone: dateTone(row, now),
      ...(row.atRisk && { alert: "At risk" }),
      quiet: false,
      lateDays: 0,
    };
  }
  if (row.state === "unrecorded" || row.state === "waiting") {
    const when = row.when ?? (row.state === "unrecorded" ? "not recorded" : "no date yet");
    return { when, tone: "default", quiet: true, lateDays: 0 };
  }
  if (row.state === "stale") return { when: row.when, tone: "soon", quiet: false, lateDays: 0 };
  const atRisk = row.state !== "done" && Boolean(row.atRisk);
  return {
    when: row.when,
    tone: atRisk ? "late" : "default",
    ...(atRisk && { alert: "At risk" }),
    quiet: false,
    lateDays: 0,
  };
}

function PhaseBar({ bar, start, now, px }: { bar: TimelinePhaseBar; start: number; now: number; px: number }) {
  const startDay = dayOf(bar.start);
  const { left, width } = spanBox(startDay, dayOf(bar.end), start, px);
  const spent = spentWidth(startDay, width, now, px);
  return (
    <span className="timeline-phase-bar" data-phase={bar.phase} style={{ left, width }}>
      {spent > 0 && <i className="timeline-phase-spent" style={{ width: spent }} />}
    </span>
  );
}

interface Cutout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BarSpec {
  mark: string;
  left: number;
  width: number;
  outside: boolean;
  showMeta: boolean;
  spent?: number | undefined;
  meta?: string | undefined;
  metaTone?: Tone | undefined;
  check?: boolean | undefined;
  step?: boolean | undefined;
}

interface DateSpec {
  center: number;
  detail: string;
}

interface RowBoxBase {
  meta: RowMeta;
  rowTop: number;
  left: number;
  right: number;
  y: number;
  cutout?: Cutout;
}

export type RowBox =
  | (RowBoxBase & { kind: "bar"; row: TimelineTodo | TimelineStep; spec: BarSpec })
  | (RowBoxBase & { kind: "date"; row: TimelineDate; spec: DateSpec });

interface LaidOutRow {
  row: TimelineRow;
  meta: RowMeta;
  box: RowBox | null;
}

interface LaidOutGroup {
  group: TimelineGroup;
  open: boolean;
  rows: LaidOutRow[];
}

const dateDetail = (row: TimelineDate) =>
  row.detail ??
  [row.when, row.atRisk ? "at risk" : row.state === "proposed" ? "proposed" : undefined].filter(Boolean).join(" · ");

function barSpec(
  row: TimelineTodo | TimelineStep,
  meta: RowMeta,
  start: number,
  now: number,
  px: number,
): Omit<BarSpec, "outside" | "showMeta"> | null {
  if (row.kind === "step") {
    const startDay = dayOf(row.start);
    const left = (startDay - start) * px;
    if (row.state === "undated") {
      return {
        mark: "step-undated",
        left,
        width: Math.max((now - startDay + UNDATED_TAIL_DAYS) * px, UNDATED_MIN_WIDTH),
        step: true,
      };
    }
    const { width } = spanBox(startDay, dayOf(row.state === "done" ? row.end : row.due), start, px);
    if (row.state === "done") return { mark: "step-done", left, width, step: true };
    return {
      mark: meta.lateDays > 0 ? "step-late" : "step-open",
      left,
      width,
      meta: meta.lateDays > 0 ? `${meta.lateDays}d late` : undefined,
      metaTone: meta.tone,
      step: true,
    };
  }
  if (row.state === "unrecorded" || row.state === "waiting") return null;
  const startDay = dayOf(row.start);
  if (row.state === "stale") {
    const width = Math.max((now - startDay + 0.5) * px, MIN_BAR_WIDTH);
    return { mark: "todo-stale", left: (startDay - start) * px, width, spent: width };
  }
  const { left, width } = spanBox(startDay, dayOf(row.end), start, px);
  if (row.state === "done") return { mark: "todo-done", left, width, check: true };
  if (row.state === "expected") return { mark: "todo-expected", left, width, meta: row.length };
  return {
    mark: "todo-current",
    left,
    width,
    spent: spentWidth(startDay, width, now, px),
    meta: row.progress,
    metaTone: row.overTypical ? "soon" : "default",
  };
}

function rowBox(
  row: TimelineRow,
  meta: RowMeta,
  rowIndex: number,
  rowHeight: number,
  start: number,
  now: number,
  px: number,
  measure: Measure,
): RowBox | null {
  const rowTop = rowIndex * rowHeight;
  const y = rowTop + rowHeight / 2;
  if (row.kind === "date") {
    const center = (dayOf(row.day) - start) * px + px / 2;
    const detail = dateDetail(row);
    const labelWidth = measure(row.name) + (detail ? DIAMOND_DETAIL_GAP + measure(detail) : 0);
    return {
      kind: "date",
      row,
      meta,
      rowTop,
      left: center - DIAMOND_HALF,
      right: center + DIAMOND_HALF,
      y,
      spec: { center, detail },
      ...(labelWidth > 0 && {
        cutout: {
          id: row.id,
          x: center + DIAMOND_LABEL_OFFSET - 3,
          y: rowTop + CUTOUT_PAD_Y,
          width: labelWidth + 6,
          height: rowHeight - CUTOUT_PAD_Y * 2,
        },
      }),
    };
  }
  const base = barSpec(row, meta, start, now, px);
  if (!base) return null;
  const nameWidth = measure(row.name);
  const metaWidth = base.meta ? measure(base.meta) : base.check ? CHECK_WIDTH : 0;
  const { outside, showMeta } = labelLayout(nameWidth, metaWidth, base.width);
  const right = base.left + base.width;
  return {
    kind: "bar",
    row,
    meta,
    rowTop,
    left: base.left,
    right,
    y,
    spec: { ...base, outside, showMeta },
    ...(outside &&
      nameWidth > 0 && {
        cutout: {
          id: row.id,
          x: right + BESIDE_CUTOUT_OFFSET,
          y: rowTop + CUTOUT_PAD_Y,
          width: nameWidth + 6,
          height: rowHeight - CUTOUT_PAD_Y * 2,
        },
      }),
  };
}

export function layoutTimeline(
  groups: readonly TimelineGroup[],
  folds: Folds,
  rowHeight: number,
  start: number,
  now: number,
  px: number,
  measure: Measure,
) {
  const boxes = new Map<string, RowBox>();
  const cutouts: Cutout[] = [];
  let rowIndex = 0;
  const laidOutGroups = groups.map((group): LaidOutGroup => {
    const open = !(folds[group.id] ?? group.startsFolded);
    rowIndex++;
    if (!open) return { group, open, rows: [] };
    const rows = group.rows.map((row): LaidOutRow => {
      const meta = rowMeta(row, now);
      const box = rowBox(row, meta, rowIndex++, rowHeight, start, now, px, measure);
      if (box) {
        boxes.set(row.id, box);
        if (box.cutout) cutouts.push(box.cutout);
      }
      return { row, meta, box };
    });
    return { group, open, rows };
  });
  return { groups: laidOutGroups, boxes, cutouts, bodyHeight: rowIndex * rowHeight };
}

interface MarkProps {
  box: RowBox | null;
  hovered: boolean;
  tipId: string;
  onEnter: () => void;
  onLeave: () => void;
  onOpen?: (() => void) | undefined;
}

function RowMark({ box, hovered, tipId, onEnter, onLeave, onOpen }: MarkProps) {
  if (!box) return null;
  const events = {
    "data-hovered": hovered ? "" : undefined,
    "aria-describedby": hovered ? tipId : undefined,
    onClick: onOpen,
    onMouseEnter: onEnter,
    onMouseLeave: onLeave,
    onFocus: onEnter,
    onBlur: onLeave,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape") onLeave();
    },
  };
  if (box.kind === "date") {
    const { row, meta, spec } = box;
    return (
      <button type="button" className="timeline-date-mark" {...events} style={{ left: spec.center }}>
        <i
          className="timeline-diamond"
          data-mark={`date-${row.state}`}
          data-state={row.state}
          data-at-risk={row.atRisk ? "" : undefined}
          aria-hidden="true"
        />
        <span className="timeline-diamond-label">
          {row.name}
          {spec.detail && (
            <span className="timeline-diamond-detail" data-tone={optTone(meta.tone)}>
              {spec.detail}
            </span>
          )}
        </span>
      </button>
    );
  }
  const { row, spec } = box;
  const fullFill = spec.spent !== undefined && spec.spent >= spec.width - 1;
  return (
    <button
      type="button"
      className={spec.step ? "timeline-bar timeline-step" : "timeline-bar"}
      data-mark={spec.mark}
      data-label-pos={spec.outside ? "beside" : "inside"}
      {...events}
      style={{ left: spec.left, width: spec.width }}
    >
      {spec.spent !== undefined && spec.spent > 0 && (
        <i className="timeline-bar-fill" data-full={fullFill ? "" : undefined} style={{ width: spec.spent }} />
      )}
      <span className="timeline-bar-name">{row.name}</span>
      {spec.showMeta && (
        <span className="timeline-bar-meta" data-tone={optTone(spec.metaTone ?? "default")}>
          {spec.check ? <CheckIcon size={CHECK_WIDTH} /> : spec.meta}
        </span>
      )}
    </button>
  );
}

interface NoteContent {
  title: string;
  dates: string;
  source: string;
  tone: Tone;
}

const pluralDays = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;
const isDeadline = (link: TimelineLink): link is Extract<TimelineLink, { kind: "deadline" }> =>
  link.kind === "deadline";

function noteForRow(
  row: TimelineRow,
  meta: RowMeta,
  now: number,
  links: readonly TimelineLink[],
  rows: ReadonlyMap<string, TimelineRow>,
): NoteContent {
  const ref = yearOf(now);
  if (row.kind === "date") {
    const day = dayOf(row.day);
    const suffix = row.atRisk ? " · at risk" : row.state === "proposed" ? " · proposed" : "";
    const dates = row.state === "expected" ? `Expected ${weekdayDate(day, ref)}` : `${weekdayDate(day, ref)}${suffix}`;
    const blocker = links
      .filter((l) => isDeadline(l) && Boolean(l.atRisk) && l.to === row.id)
      .map((l) => rows.get(l.from))
      .find((r): r is Extract<TimelineTodo, { end: string }> => r?.kind === "todo" && "end" in r);
    if (row.atRisk && blocker) {
      const over = dayOf(blocker.end) - day;
      return {
        title: row.name,
        dates,
        source: over > 0 ? `${blocker.name} is expected ${pluralDays(over)} after it` : `${blocker.name} is at risk`,
        tone: "late",
      };
    }
    const fallback = row.atRisk
      ? "Expected work finishes after this date"
      : row.state === "proposed"
        ? "Proposed, not confirmed"
        : row.state === "expected"
          ? "From workflow typical lengths"
          : "Recorded";
    return { title: row.name, dates, source: row.note ?? fallback, tone: row.atRisk ? "late" : "default" };
  }
  if (row.kind === "step") {
    const set = `${row.owner} · set ${shortDate(dayOf(row.start), ref)}`;
    if (row.state === "done")
      return {
        title: row.name,
        dates: `${set} · done ${shortDate(dayOf(row.end), ref)}`,
        source: row.note ?? "Recorded",
        tone: "default",
      };
    if (row.state === "undated")
      return { title: row.name, dates: `${set} · no due date`, source: row.note ?? "Recorded", tone: "default" };
    return {
      title: row.name,
      dates: `${set} · due ${weekdayDate(dayOf(row.due), ref)}`,
      source: meta.lateDays > 0 ? `${pluralDays(meta.lateDays)} late` : (row.note ?? "Recorded"),
      tone: meta.lateDays > 0 ? "late" : "default",
    };
  }
  if (row.state === "done")
    return {
      title: row.name,
      dates: `Finished ${weekdayDate(dayOf(row.end), ref)}`,
      source: row.note ?? "Recorded",
      tone: "default",
    };
  if (row.state === "stale") {
    return {
      title: row.name,
      dates: `Started ${shortDate(dayOf(row.start), ref)}${row.when ? ` · ${row.when}` : ""}`,
      source: row.note ?? "Too far past typical to expect a date",
      tone: "soon",
    };
  }
  if (row.state === "unrecorded" || row.state === "waiting")
    return { title: row.name, dates: meta.when ?? "", source: row.note ?? "", tone: "default" };
  const startDay = dayOf(row.start);
  const endDay = dayOf(row.end);
  const span = `${shortDate(startDay, ref)} to ${shortDate(endDay, ref)}`;
  const dates = row.state === "current" ? `${span}${row.progress ? ` · ${row.progress}` : ""}` : `Expected ${span}`;
  const missed = links
    .filter((l) => isDeadline(l) && Boolean(l.atRisk) && l.from === row.id)
    .map((l) => rows.get(l.to))
    .find((r): r is TimelineDate => r?.kind === "date");
  if (missed) {
    const over = endDay - dayOf(missed.day);
    return {
      title: row.name,
      dates,
      source: over > 0 ? `Expected ${pluralDays(over)} after ${missed.name}` : `At risk for ${missed.name}`,
      tone: "late",
    };
  }
  return {
    title: row.name,
    dates,
    source: row.note ?? `Typical length ${pluralDays(Math.max(1, endDay - startDay))}`,
    tone: row.atRisk ? "late" : row.state === "current" && row.overTypical ? "soon" : "default",
  };
}

function Arrows({
  links,
  boxes,
  cutouts,
  hoveredId,
  width,
  height,
  rowHeight,
  maskId,
}: {
  links: readonly TimelineLink[];
  boxes: ReadonlyMap<string, RowBox>;
  cutouts: readonly Cutout[];
  hoveredId: string | null;
  width: number;
  height: number;
  rowHeight: number;
  maskId: string;
}) {
  const routed = links
    .flatMap((link) => {
      const from = boxes.get(link.from);
      const to = boxes.get(link.to);
      if (!from || !to) return [];
      const atRisk = isDeadline(link) && Boolean(link.atRisk);
      const active = hoveredId !== null && (link.from === hoveredId || link.to === hoveredId);
      return [
        { link, atRisk, active, route: arrowPath({ x: from.right, y: from.y }, { x: to.left, y: to.y }, rowHeight) },
      ];
    })
    // Paint normal links first, at-risk links above them, and hovered links on top.
    .sort((a, b) => Number(a.active) - Number(b.active) || Number(a.atRisk) - Number(b.atRisk));
  if (routed.length === 0) return null;
  const maskWidth = Math.max(width, ...cutouts.map((c) => c.x + c.width)) + 20;
  return (
    <svg
      className="timeline-links"
      data-dim={hoveredId !== null ? "" : undefined}
      width={width}
      height={height}
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={maskWidth} height={height}>
          <rect x={0} y={0} width={maskWidth} height={height} fill="white" stroke="none" />
          {cutouts.map((c) => (
            <rect
              key={c.id}
              data-cutout={c.id}
              x={c.x}
              y={c.y}
              width={c.width}
              height={c.height}
              rx={4}
              fill="black"
              stroke="none"
            />
          ))}
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        {routed.map(({ link, atRisk, active, route }) => (
          <path
            key={`${link.kind}:${link.from}->${link.to}`}
            className="timeline-link"
            data-from={link.from}
            data-to={link.to}
            data-link-kind={link.kind}
            data-at-risk={atRisk ? "" : undefined}
            data-back-route={route.backRoute ? "" : undefined}
            data-active={active ? "" : undefined}
            d={route.path}
          />
        ))}
      </g>
    </svg>
  );
}

export function Timeline({
  foldKey,
  today,
  from,
  to,
  groups,
  links = [],
  controls,
  board,
  reveal,
  onOpen,
  toolsHost,
}: TimelineViewProps) {
  // middle is the day to centre after a zoom change; null puts today a third of the way in.
  const [view, setView] = useState<{ zoom: Zoom; middle: number | null }>({ zoom: "week", middle: null });
  const [folds, setFolds] = useState(() => readFolds(foldKey));
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const corner = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [pillWidth, setPillWidth] = useState(0);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const [font, setFont] = useState("");
  const uid = useId();
  useScrollCue(scroller);
  const { zoom } = view;
  const start = dayOf(from);
  const now = dayOf(today);
  const px = DAY_WIDTH[zoom];
  const x = (day: number) => (day - start) * px;
  const { months, days, saturdays } = scale(start, dayOf(to), zoom);
  const width = x(dayOf(to));
  const labelCentre = (day: number) => x(day) + (zoom === "day" ? px / 2 : 0);
  const pillCovers = (day: number) => Math.abs(labelCentre(day) - (x(now) + px / 2)) < pillWidth / 2 + DATE_LABEL_HALF;

  useLayoutEffect(() => setPillWidth(pill.current?.offsetWidth ?? 0), []);

  // Row height changes at the mobile breakpoint, so arrows read the live token value.
  useLayoutEffect(() => {
    const read = () => {
      const value = rootRef.current
        ? parseFloat(getComputedStyle(rootRef.current).getPropertyValue("--row"))
        : Number.NaN;
      setRowHeight(Number.isFinite(value) && value > 0 ? value : DEFAULT_ROW_HEIGHT);
    };
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  // Labels are measured in the font the bars really use, once it has loaded.
  useLayoutEffect(() => {
    const read = () => setFont(probe.current ? getComputedStyle(probe.current).font : "");
    read();
    void document.fonts?.ready.then(read);
  }, []);
  const measure = useMemo(() => textMeasurer(font), [font]);
  useCoveredLabels(scroller, corner);

  useLayoutEffect(() => {
    const visible = visibleTrack(scroller.current, corner.current);
    const [day, at] = view.middle === null ? [now + 0.5, 1 / 3] : [view.middle, 1 / 2];
    scroller.current?.scrollTo({ left: Math.max(0, (day - start) * DAY_WIDTH[view.zoom] - visible * at) });
  }, [view, now, start]);

  useLayoutEffect(() => {
    if (!reveal || !scroller.current) return;
    const parent = groups.find((group) => group.id === reveal.group);
    if (!parent) return;
    if (reveal.row && (folds[parent.id] ?? parent.startsFolded)) {
      setFolds({ ...folds, [parent.id]: false });
      return;
    }
    const row = [...scroller.current.querySelectorAll<HTMLElement>("[data-row], [data-group]")].find((item) =>
      reveal.row ? item.dataset.row === reveal.row : item.dataset.group === reveal.group,
    );
    if (!row) return;
    const scroll = scroller.current;
    scroll.scrollTo({
      left: (dayOf(reveal.day) - start + 0.5) * px - visibleTrack(scroll, corner.current) / 2,
      top:
        scroll.scrollTop +
        row.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top -
        (corner.current?.offsetHeight ?? 0),
    });
  }, [reveal, folds, groups, start, px]);

  function changeZoom(next: Zoom) {
    const left = scroller.current?.scrollLeft ?? 0;
    setView({ zoom: next, middle: start + (left + visibleTrack(scroller.current, corner.current) / 2) / px });
  }

  function toggle(group: TimelineGroup) {
    const next = { ...folds, [group.id]: !(folds[group.id] ?? group.startsFolded) };
    setFolds(next);
    writeFolds(foldKey, next);
  }

  const allRows = useMemo(() => new Map(groups.flatMap((g) => g.rows.map((r) => [r.id, r] as const))), [groups]);
  const {
    groups: laidOutGroups,
    boxes,
    cutouts,
    bodyHeight,
  } = layoutTimeline(groups, folds, rowHeight, start, now, px, measure);
  const activeHovered = hoveredId !== null && boxes.has(hoveredId) ? hoveredId : null;
  const hoveredBox = activeHovered ? boxes.get(activeHovered) : undefined;
  const note = hoveredBox ? noteForRow(hoveredBox.row, hoveredBox.meta, now, links, allRows) : undefined;
  const tipId = `${uid}-tip`;
  const maskId = `${uid}-arrow-mask`;
  const clearHover = (id: string) => setHoveredId((current) => (current === id ? null : current));
  useTipPosition(tipRef, scroller, corner, hoveredBox, rowHeight, note, font);

  const tools = (
    <div className="timeline-tools">
      {controls}
      <fieldset className="timeline-zoom" aria-label="Zoom">
        {ZOOMS.filter((z) => !board || z !== "day").map((z) => (
          <button key={z} type="button" aria-pressed={z === zoom} onClick={() => changeZoom(z)}>
            {ZOOM_LABEL[z]}
          </button>
        ))}
      </fieldset>
      <button type="button" onClick={() => setView({ zoom, middle: null })}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
        Today
      </button>
    </div>
  );

  return (
    <section className="timeline" ref={rootRef} data-day-width={px}>
      <p className="timeline-sr">
        The chart runs from {from} to {to}. Today is {today}.
      </p>
      <span ref={probe} className="timeline-bar timeline-probe" aria-hidden="true" />
      {toolsHost ? createPortal(tools, toolsHost) : tools}
      <section className="timeline-scroll" ref={scroller} aria-label="Timeline">
        <div className="timeline-canvas">
          <div className="timeline-head">
            <div className="timeline-corner" ref={corner} />
            <div className="timeline-dates" style={{ width }} aria-hidden="true">
              {months.map((m, i) => (
                <div
                  key={m.day}
                  className="timeline-month"
                  style={{ left: x(m.day), width: x(months[i + 1]?.day ?? dayOf(to)) - x(m.day) }}
                >
                  <span>{m.label}</span>
                </div>
              ))}
              {days.map(
                (d) =>
                  !pillCovers(d.day) && (
                    <span key={d.day} className="timeline-date" style={{ left: labelCentre(d.day) }}>
                      {d.label}
                    </span>
                  ),
              )}
              <span ref={pill} className="timeline-today" style={{ left: x(now) + px / 2 }}>
                Today
              </span>
            </div>
          </div>
          <div className="timeline-body">
            <div className="timeline-grid" aria-hidden="true">
              {saturdays.map((d) => (
                <i
                  key={d}
                  className="timeline-weekend"
                  style={{ left: Math.max(0, x(d)), width: Math.min(x(d) + 2 * px, 2 * px) }}
                />
              ))}
              {months
                .filter((m) => m.day > start)
                .map((m) => (
                  <i key={m.day} className="timeline-month-line" style={{ left: x(m.day) }} />
                ))}
              <i className="timeline-now" style={{ left: x(now) + px / 2 }} />
            </div>
            <Arrows
              links={links}
              boxes={boxes}
              cutouts={cutouts}
              hoveredId={activeHovered}
              width={width}
              height={bodyHeight}
              rowHeight={rowHeight}
              maskId={maskId}
            />
            {laidOutGroups.map(({ group, open, rows }) => {
              const heading = (
                <>
                  <span className="timeline-group-title">
                    {group.href ? (
                      <a className="timeline-name" href={group.href}>
                        {group.name}
                      </a>
                    ) : (
                      <span className="timeline-name">{group.name}</span>
                    )}
                    {group.attention && (
                      <span
                        className="timeline-attention"
                        role="img"
                        aria-label={group.attention}
                        title={group.attention}
                      />
                    )}
                    {group.done && <CheckIcon size={14} className="timeline-glyph-check" />}
                  </span>
                  {group.count && <span className="timeline-when">{group.count}</span>}
                  {group.owner && (
                    <span className="timeline-owner" role="img" aria-label={group.owner}>
                      {group.owner[0]}
                    </span>
                  )}
                </>
              );
              return (
                <Fragment key={group.id}>
                  <div className="timeline-row timeline-group" data-group={group.id}>
                    {group.href ? (
                      <div className="timeline-label">
                        {group.rows.length > 0 ? (
                          <button
                            type="button"
                            aria-label={`Show rows for ${group.name}`}
                            aria-expanded={open}
                            onClick={() => toggle(group)}
                          >
                            <svg
                              className="timeline-chevron"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              aria-hidden="true"
                            >
                              <path d="M10 6l6 6-6 6" />
                            </svg>
                          </button>
                        ) : (
                          <span className="timeline-chevron-gap" aria-hidden="true" />
                        )}
                        {heading}
                      </div>
                    ) : group.rows.length > 0 ? (
                      <button
                        type="button"
                        className="timeline-label"
                        aria-expanded={open}
                        aria-controls={open ? group.rows.map((row) => rowId(uid, row)).join(" ") : undefined}
                        onClick={() => toggle(group)}
                      >
                        <svg className="timeline-chevron" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M10 6l6 6-6 6" />
                        </svg>
                        {heading}
                      </button>
                    ) : (
                      <div className="timeline-label timeline-label-static">
                        <span className="timeline-chevron-gap" aria-hidden="true" />
                        {heading}
                      </div>
                    )}
                    <div className="timeline-track" style={{ width }}>
                      {(group.bars ?? (group.bar ? [group.bar] : [])).map((bar) => (
                        <PhaseBar key={bar.phase} bar={bar} start={start} now={now} px={px} />
                      ))}
                      {group.signing && (
                        <span
                          className="timeline-group-signing"
                          data-phase="closing"
                          style={{ left: x(dayOf(group.signing.day)) + px / 2 }}
                        >
                          <i
                            className="timeline-glyph-diamond"
                            data-state={group.signing.recorded ? "confirmed" : "expected"}
                          />
                          {group.signing.recorded ? "" : "exp. "}
                          {shortDate(dayOf(group.signing.day), yearOf(now))}
                        </span>
                      )}
                    </div>
                  </div>
                  {open &&
                    rows.map(({ row, meta, box }) => {
                      const { when, tone, alert, quiet } = meta;
                      return (
                        <div
                          key={row.id}
                          id={rowId(uid, row)}
                          className="timeline-row"
                          data-row={row.id}
                          data-quiet={quiet ? "" : undefined}
                        >
                          <div className="timeline-label">
                            <RowGlyph row={row} />
                            {onOpen ? (
                              <button type="button" className="timeline-name" onClick={() => onOpen(row.id)}>
                                {row.name}
                              </button>
                            ) : (
                              <span className="timeline-name">{row.name}</span>
                            )}
                            {alert && (
                              <span className="timeline-alert" role="img" aria-label={alert}>
                                !
                              </span>
                            )}
                            {when && (
                              <span className="timeline-when" data-tone={optTone(tone)}>
                                {when}
                              </span>
                            )}
                          </div>
                          <div className="timeline-track" data-phase={row.phase} style={{ width }}>
                            <RowMark
                              box={box}
                              hovered={activeHovered === row.id}
                              tipId={tipId}
                              onOpen={onOpen && (() => onOpen(row.id))}
                              onEnter={() => setHoveredId(row.id)}
                              onLeave={() => clearHover(row.id)}
                            />
                          </div>
                        </div>
                      );
                    })}
                </Fragment>
              );
            })}
            <div className="timeline-list-fill" />
            {hoveredBox && note && (
              <div ref={tipRef} id={tipId} role="tooltip" className="timeline-tip" data-for={hoveredBox.row.id}>
                <strong className="timeline-tip-title">{note.title}</strong>
                <span className="timeline-tip-line">{note.dates}</span>
                {note.source && (
                  <span className="timeline-tip-line" data-tone={optTone(note.tone)}>
                    {note.source}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </section>
  );
}

export function mountTimeline(host: HTMLElement, initial: TimelineProps) {
  const root = createRoot(host);
  let disposed = false;
  function update(props: TimelineProps) {
    if (disposed) return;
    flushSync(() => root.render(<Timeline key={props.foldKey} {...props} />));
  }
  update(initial);
  return {
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.unmount();
    },
  };
}
