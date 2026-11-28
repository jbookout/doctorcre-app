import type {
  TimelineGroup,
  TimelineLink,
  TimelinePartner,
  TimelinePhase,
  TimelinePhaseBar,
  TimelineRow,
} from "./timeline.tsx";
import { dayOf, shortDate, yearOf } from "./timeline-scale.ts";

export const PHASES = {
  pending: "Prospective Client",
  research: "Research",
  site_selection: "Site Selection",
  negotiation: "Negotiating",
  legal: "Legal",
  due_diligence: "Due Diligence",
  closing: "Closing",
  closed: "Closed",
} satisfies Record<TimelinePhase, string>;

type PhaseSpan = {
  phase: TimelinePhase;
  from_on: string | null;
  to_on: string | null;
  expected_from_on: string | null;
  expected_to_on: string | null;
};
type Todo = { kind: "todo"; id: string; phase: TimelinePhase; label: string; typical_days: number | null } & (
  | { state: "finished"; from_on: string | null; to_on: string | null }
  | { state: "current"; from_on: string | null; expected_to_on: string | null; day: number | null }
  | { state: "expected"; expected_from_on: string | null; expected_to_on: string | null }
  | { state: "undated" | "not_recorded" }
);
type Step = {
  kind: "step";
  id: string;
  phase: TimelinePhase | null;
  owner: string | null;
  state: "open" | "late" | "done";
  from_on: string;
  to_on: string | null;
  done_on: string | null;
  label?: string;
  change_id?: number | null;
};
type CriticalDate = {
  kind: "critical_date";
  id: string;
  phase: TimelinePhase | null;
  label: string;
  on: string;
  status: "proposed" | "open" | "cleared";
  at_risk: boolean;
};
type PlanRow = Todo | Step | CriticalDate;
type Arrow = { from: string; to: string; at_risk: boolean };

export interface Plan {
  phases: PhaseSpan[];
  rows: PlanRow[];
  arrows: Arrow[];
  expected_signing_on: string | null;
  stale: { phase: TimelinePhase; days: number } | null;
  own_dates?: Record<string, string>;
  base_version?: number;
}
export interface DealTimeline {
  id: string;
  phase: TimelinePhase;
  owner: string;
  name: string;
  short_name?: string | null;
  attention?: { reason: string } | null;
  timeline: Omit<Plan, "phases"> & {
    phase_spans: PhaseSpan[];
    at_risk_count: number;
    dates: CriticalDate[];
    signing_recorded?: boolean;
  };
}
export type SourceStep = { id: string; description: string; display_title?: string; change_id: number | null };

export const partner = (slug: string | null): TimelinePartner | undefined =>
  slug === "joe" ? "Joe" : slug === "dell" ? "Dell" : undefined;
export const dayText = (day: string, today: string) => shortDate(dayOf(day), yearOf(dayOf(today)));
export const dateAfter = (day: string, offset: number) =>
  new Date((dayOf(day) + offset) * 86400000).toISOString().slice(0, 10);

export function chartRow(
  row: PlanRow,
  phase: TimelinePhase,
  today: string,
  steps: Map<string, SourceStep>,
  risk: Set<string>,
): TimelineRow | null {
  if (row.kind === "critical_date")
    return {
      kind: "date",
      id: row.id,
      name: row.label,
      phase,
      day: row.on,
      state: row.status === "proposed" ? "proposed" : "confirmed",
      atRisk: row.at_risk,
      when: dayText(row.on, today),
      detail: row.status === "cleared" ? "Done" : undefined,
    };
  if (row.kind === "step") {
    const owner = partner(row.owner);
    if (!owner) return null;
    const step = steps.get(row.id);
    const base = {
      kind: "step" as const,
      id: row.id,
      name: step?.display_title || row.label || step?.description || "Next step",
      phase,
      owner,
      start: row.from_on,
    };
    if (row.state === "done" && (row.done_on || row.to_on))
      return {
        ...base,
        state: "done",
        end: row.done_on || row.to_on || row.from_on,
        when: `Done ${dayText(row.done_on || row.to_on || row.from_on, today)}`,
      };
    return row.to_on
      ? { ...base, state: "open", due: row.to_on, when: dayText(row.to_on, today) }
      : { ...base, state: "undated" };
  }
  const base = { kind: "todo" as const, id: row.id, name: row.label, phase };
  if (row.state === "finished" && row.to_on)
    return { ...base, state: "done", start: row.from_on ?? row.to_on, end: row.to_on, when: dayText(row.to_on, today) };
  if (row.state === "current" && row.from_on) {
    return {
      ...base,
      state: "current",
      start: row.from_on,
      end: row.expected_to_on ?? today,
      progress: row.day && row.typical_days ? `day ${row.day} of ${row.typical_days}` : undefined,
      when: row.expected_to_on ? `exp. ${dayText(row.expected_to_on, today)}` : undefined,
      atRisk: risk.has(row.id),
    };
  }
  if (row.state === "expected" && row.expected_to_on)
    return {
      ...base,
      state: "expected",
      start: row.expected_from_on ?? row.expected_to_on,
      end: row.expected_to_on,
      when: `exp. ${dayText(row.expected_to_on, today)}`,
      length: row.typical_days ? `${row.typical_days}d` : undefined,
      atRisk: risk.has(row.id),
    };
  return { ...base, state: row.state === "finished" || row.state === "not_recorded" ? "unrecorded" : "waiting" };
}

export function phaseBar(span: PhaseSpan, today: string, recorded: boolean): TimelinePhaseBar | undefined {
  const start = span.from_on ?? (recorded ? null : span.expected_from_on);
  if (!start) return undefined;
  return {
    phase: span.phase,
    start,
    end: span.to_on ?? (!recorded && span.expected_to_on ? span.expected_to_on : today),
  };
}

export function chartLinks(arrows: Arrow[], rows: PlanRow[]): TimelineLink[] {
  const dates = new Set(rows.filter((row) => row.kind === "critical_date").map((row) => row.id));
  return arrows.map(({ from, to, at_risk }) =>
    dates.has(to) ? { kind: "deadline", from, to, atRisk: at_risk } : { kind: "workflow", from, to },
  );
}

export function rowDay(row: TimelineRow) {
  if (row.kind === "date") return row.day;
  if ("end" in row) return row.end;
  return "due" in row ? row.due : null;
}

export function range(groups: TimelineGroup[], today: string) {
  const from = [dateAfter(today, -21)];
  const to = [dateAfter(today, 100)];
  for (const group of groups) {
    for (const bar of group.bars ?? (group.bar ? [group.bar] : [])) {
      from.push(bar.start);
      to.push(bar.end);
    }
    if (group.signing) to.push(group.signing.day);
    for (const row of group.rows) {
      if ("start" in row) from.push(row.start);
      const day = rowDay(row);
      if (day) {
        from.push(day);
        to.push(day);
      }
    }
  }
  from.sort();
  to.sort();
  return { from: from[0] ?? today, to: dateAfter(to.at(-1) ?? today, 15) };
}
