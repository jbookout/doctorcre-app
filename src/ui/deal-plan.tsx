import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { savePlanChange, TypicalLengths } from "./deal-plan-lengths.tsx";
import {
  chartLinks,
  chartRow,
  type DealTimeline,
  dateAfter,
  dayText,
  PHASES,
  type Plan,
  partner,
  phaseBar,
  previewDates,
  range,
  rowDay,
  type SourceStep,
} from "./deal-plan-model.ts";
import { Timeline, type TimelineGroup, type TimelineLink, type TimelineRow } from "./timeline.tsx";

type Change = { id: string; day: string };
type Undo = { path: string; args: object; label: string };
type View = "mine" | "risk" | "soon";
type Milestone = {
  group: string;
  row?: string | undefined;
  day: string;
  label: string;
  deal?: string;
  expected?: boolean;
};
type Inputs = { today: string; viewer: string; request: typeof fetch; reload: () => Promise<unknown> } & (
  | {
      mode: "plan";
      deal: string;
      phase: keyof typeof PHASES;
      plan: Plan;
      steps: SourceStep[];
      canSave: boolean;
      kind: string | null;
    }
  | { mode: "board"; deals: DealTimeline[]; canSave: boolean; toolsHost: HTMLElement }
);
const signingName = (recorded: boolean) => (recorded ? "Lease signed" : "Lease signing");
const stepMap = (steps: SourceStep[]) => new Map(steps.map((step) => [`step:${step.id}`, step]));

function PlanScreen(props: Inputs) {
  const { today, viewer } = props;
  const board = props.mode === "board";
  const [owner, setOwner] = useState("");
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [sort, setSort] = useState("phase");
  const [reveal, setReveal] = useState<Milestone>();
  const [opened, setOpened] = useState<string>();
  const [preview, setPreview] = useState<Change | null>(null);
  const [edit, setEdit] = useState<"date" | "done" | "drop">();
  const [status, setStatus] = useState("");
  const [undo, setUndo] = useState<Undo>();
  const [lengths, setLengths] = useState(false);
  const [reset, setReset] = useState(false);
  const saving = useRef(false);
  const openedDate = useRef<((day: string) => void) | null>(null);
  const openedStepVersion = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const sourceSteps = new Map<string, { change_id?: number | null; due: string | null }>();
  const through = dateAfter(today, 14);
  const soon = (day: string | null) => day !== null && day >= today && day <= through;
  const atRisk = (row: TimelineRow) => "atRisk" in row && row.atRisk;
  const mine = (row: TimelineRow) => row.kind === "step" && row.owner === partner(viewer);
  const expected = (row: TimelineRow) => row.kind === "todo" && row.state === "expected";
  const groups: TimelineGroup[] = [];
  const links: TimelineLink[] = [];
  const milestones: Milestone[] = [];
  let count = "",
    myCount = 0,
    riskCount = 0,
    soonCount = 0;
  const rowsById = new Map<string, TimelineRow>();
  const selectRows = (rows: TimelineRow[]) =>
    rows
      .filter(
        (row) =>
          (!recorded || !expected(row)) &&
          (!owner || row.kind !== "step" || row.owner === partner(owner)) &&
          (!filter || row.name.toLowerCase().includes(filter.toLowerCase())),
      )
      .map((row) =>
        recorded && row.kind === "todo" && row.state === "current" ? { ...row, end: today, when: "In progress" } : row,
      );

  if (props.mode === "plan") {
    const { plan, phase } = props;
    const steps = stepMap(props.steps);
    for (const row of plan.rows)
      if (row.kind === "step")
        sourceSteps.set(row.id, { change_id: steps.get(row.id)?.change_id ?? null, due: row.to_on });
    const ranks = Object.keys(PHASES);
    count = `${plan.rows.filter((row) => row.kind === "todo").length} to-dos · ${plan.rows.filter((row) => row.kind === "step").length} steps`;
    const risk = new Set(plan.arrows.filter((arrow) => arrow.at_risk).map((arrow) => arrow.from));
    for (const span of plan.phases) {
      const facts = plan.rows.filter((row) => (row.phase ?? phase) === span.phase);
      const todos = facts.filter((row) => row.kind === "todo");
      const all = selectRows(facts.flatMap((row) => chartRow(row, span.phase, today, steps, risk) ?? []));
      myCount += all.filter(mine).length;
      riskCount += all.filter((row) => row.kind === "date" && atRisk(row)).length;
      soonCount += all.filter((row) => soon(rowDay(row))).length;
      for (const row of all) rowsById.set(row.id, row);
      const rows = all.filter((row) =>
        view === "mine" ? mine(row) : view === "risk" ? atRisk(row) : view === "soon" ? soon(rowDay(row)) : true,
      );
      const folded = ranks.indexOf(span.phase) < ranks.indexOf(phase);
      if (!rows.length && (view || filter)) continue;
      groups.push({
        id: span.phase,
        name: PHASES[span.phase],
        count:
          plan.stale?.phase === span.phase
            ? `${plan.stale.days} days in ${PHASES[span.phase]}`
            : todos.length
              ? `${todos.filter((row) => row.state === "finished").length} of ${todos.length}`
              : "Nothing listed",
        startsFolded: folded,
        done: folded && todos.length > 0 && todos.every((row) => row.state === "finished"),
        bar: phaseBar(span, today, recorded),
        rows,
      });
      for (const row of facts)
        if (
          row.kind === "critical_date" &&
          row.status !== "cleared" &&
          row.on >= today &&
          rows.some((item) => item.id === row.id)
        ) {
          milestones.push({ group: span.phase, row: row.id, day: row.on, label: row.label });
        }
    }
    links.push(...chartLinks(plan.arrows, plan.rows));
    const signed = plan.rows.some(
      (row) => row.kind === "todo" && row.id === "executed_lease" && row.state === "finished",
    );
    if (plan.expected_signing_on && (!recorded || signed) && groups.some((group) => group.id === "closing")) {
      milestones.push({
        group: "closing",
        row: groups.find((group) => group.id === "closing")?.rows.find((row) => row.id === "executed_lease")?.id,
        day: plan.expected_signing_on,
        label: signingName(signed),
        expected: !signed,
      });
    }
  } else {
    const ranks = Object.keys(PHASES);
    const phaseOrder = (a: DealTimeline, b: DealTimeline) =>
      ranks.indexOf(b.phase) - ranks.indexOf(a.phase) || a.name.localeCompare(b.name);
    const bySigning = (a: DealTimeline, b: DealTimeline) =>
      (a.timeline.expected_signing_on ?? "9999").localeCompare(b.timeline.expected_signing_on ?? "9999");
    const deals = props.deals
      .filter((deal) => deal.timeline)
      .sort(
        (a, b) =>
          (sort === "owner" ? a.owner.localeCompare(b.owner) : sort === "signing" ? bySigning(a, b) : 0) ||
          phaseOrder(a, b),
      );
    count = `${deals.length} open ${deals.length === 1 ? "deal" : "deals"}`;
    for (const deal of deals) {
      const { timeline, phase, id } = deal;
      const name = deal.short_name || deal.name;
      const signingOn = timeline.expected_signing_on;
      const signed = timeline.signing_recorded === true;
      const signing =
        signingOn && (!recorded || signed) && !timeline.stale ? { day: signingOn, recorded: signed } : undefined;
      const near = (signing && soon(signing.day)) || timeline.dates.some((date) => soon(date.on));
      myCount += Number(deal.owner === viewer);
      riskCount += Number(timeline.at_risk_count > 0);
      soonCount += Number(Boolean(near));
      if (
        (view === "mine" && deal.owner !== viewer) ||
        (view === "risk" && !timeline.at_risk_count) ||
        (view === "soon" && !near)
      )
        continue;
      const risk = new Set(timeline.arrows.filter((arrow) => arrow.at_risk).map((arrow) => arrow.from));
      const prefix = (row: string) => `${id}/${row}`;
      for (const row of timeline.rows)
        if (row.kind === "step") sourceSteps.set(prefix(row.id), { change_id: row.change_id ?? null, due: row.to_on });
      const rows = selectRows(timeline.rows.flatMap((row) => chartRow(row, phase, today, new Map(), risk) ?? [])).map(
        (row) => ({ ...row, id: prefix(row.id) }),
      );
      for (const row of rows) rowsById.set(row.id, row);
      links.push(
        ...chartLinks(timeline.arrows, timeline.rows).map((link) => ({
          ...link,
          from: prefix(link.from),
          to: prefix(link.to),
        })),
      );
      const bars = timeline.phase_spans
        .filter((span) => !timeline.stale || span.phase === timeline.stale.phase)
        .flatMap((span) => phaseBar(span, today, recorded || Boolean(timeline.stale)) ?? []);
      groups.push({
        id,
        name,
        href: `/deals?view=timeline&deal=${encodeURIComponent(id)}`,
        count: timeline.stale ? `${timeline.stale.days} days in ${PHASES[timeline.stale.phase]}` : PHASES[phase],
        startsFolded: true,
        attention: deal.attention?.reason,
        owner: partner(deal.owner),
        signing,
        bars,
        rows,
      });
      for (const date of timeline.dates)
        if (date.on >= today) {
          milestones.push({
            group: id,
            row: rows.some((row) => row.id === prefix(date.id)) ? prefix(date.id) : undefined,
            day: date.on,
            label: date.label,
            deal: name,
          });
        }
      if (signing)
        milestones.push({ group: id, day: signing.day, label: signingName(signed), deal: name, expected: !signed });
    }
  }

  const controls = (
    <div className="timeline-filters">
      {board ? (
        <select aria-label="Sort deals" value={sort} onChange={(event) => setSort(event.currentTarget.value)}>
          <option value="phase">Furthest along</option>
          <option value="owner">By owner</option>
          <option value="signing">Expected signing</option>
        </select>
      ) : (
        <>
          <input
            className="timeline-search"
            aria-label="Filter steps"
            placeholder="Filter steps"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
          <fieldset aria-label="Step owner">
            {["", "dell", "joe"].map((slug) => (
              <button type="button" key={slug} aria-pressed={owner === slug} onClick={() => setOwner(slug)}>
                {partner(slug) ?? "Both"}
              </button>
            ))}
          </fieldset>
        </>
      )}
    </div>
  );
  const planPath = props.mode === "plan" ? `deals/${props.deal}/plan-dates` : null;
  const version = props.mode === "plan" ? props.plan.base_version : undefined;
  const own = props.mode === "plan" ? (props.plan.own_dates ?? {}) : {};
  const factsFor = (id: string) => {
    const [deal, item] = props.mode === "board" ? id.split("/") : ["", id];
    const facts =
      props.mode === "board" ? props.deals.find((entry) => entry.id === deal)?.timeline.rows : props.plan.rows;
    return facts?.find((row) => row.id === item);
  };
  const update = async (
    path: string,
    args: object,
    success: string,
    makeUndo?: (body: { change_id?: number; base_version?: number; previous_on?: string | null }) => Undo | undefined,
  ) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setStatus("Saving…");
    try {
      const response = await savePlanChange(props.request, path, args);
      if (!response.ok) {
        if (response.status === 409) {
          setUndo(undefined);
          setEdit(undefined);
          setOpened(undefined);
          setStatus(
            path.startsWith("next-steps/")
              ? "This step changed. Review the latest version."
              : "This item changed. Review the latest version.",
          );
          await props.reload();
        } else setStatus("Could not save this change.");
        return;
      }
      const result = await response.json();
      setStatus(success);
      setUndo(makeUndo?.(result));
      setEdit(undefined);
      await props.reload();
    } catch {
      setStatus("Could not confirm the save. Refresh to see the latest version.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  function changeDate(id: string, day: string) {
    const row = rowsById.get(id);
    if (!row) return;
    const label = `${row.name} moved to ${dayText(day, today)}.`;
    const source = sourceSteps.get(id);
    const fact = factsFor(id);
    if (fact?.kind === "step" && source?.change_id != null) {
      const path = `next-steps/${fact.id.slice("step:".length)}/changes`;
      void update(path, { due_on: day, seen_change_id: source.change_id }, label, (body) =>
        body.change_id == null
          ? undefined
          : { path, args: { due_on: source.due, seen_change_id: body.change_id }, label: `${row.name} date restored.` },
      );
    } else if (planPath && version != null && row.kind === "todo") {
      void update(
        planPath,
        { todo: id, target_on: day, base_version: version },
        `${row.name} expected by ${dayText(day, today)}. What follows moved with it.`,
        (body) =>
          body.base_version == null
            ? undefined
            : {
                path: planPath,
                args: { todo: id, target_on: body.previous_on ?? null, base_version: body.base_version },
                label: `${row.name} date restored.`,
              },
      );
    }
  }
  const displayed = preview ? previewDates(groups, links, preview, own, today) : { groups, links };
  const selected = opened ? rowsById.get(opened) : undefined;
  const selectedFacts = opened ? factsFor(opened) : undefined;
  const stepVersion = openedStepVersion.current;
  const canSetDate =
    (selected?.kind === "step" &&
      selectedFacts?.kind === "step" &&
      selectedFacts.state !== "done" &&
      stepVersion != null) ||
    (selected?.kind === "todo" &&
      selected.state === "expected" &&
      version != null &&
      Boolean(selectedFacts?.kind === "todo" && selectedFacts.state === "expected" && selectedFacts.expected_from_on));
  const foldKey = props.mode === "plan" ? `deal-${props.deal}` : "deals";
  return (
    <div className="deal-plan" data-board={board || undefined}>
      <aside className="deal-plan-list">
        <h3>Milestones</h3>
        <ul>
          {milestones
            .sort((a, b) => a.day.localeCompare(b.day))
            .slice(0, board ? 6 : undefined)
            .map((item) => (
              <li key={`${item.group}:${item.row ?? item.label}`}>
                <button type="button" onClick={() => setReveal({ ...item })}>
                  <i aria-hidden="true" />
                  <span>
                    {item.label}
                    {item.deal && <small>{item.deal}</small>}
                  </span>
                  <small>
                    {item.expected ? "exp. " : ""}
                    {dayText(item.day, today)}
                  </small>
                </button>
              </li>
            ))}
        </ul>
        {!milestones.length && <p>No upcoming milestones</p>}
        <h3>Saved views</h3>
        {(
          [
            ["mine", board ? "My deals" : "My steps", myCount],
            ["risk", "At risk", riskCount],
            ["soon", "Next two weeks", soonCount],
          ] satisfies [View, string, number][]
        ).map(([key, label, total]) => (
          <button
            type="button"
            key={key}
            aria-pressed={view === key}
            onClick={() => {
              setView(view === key ? null : key);
              setReveal(undefined);
            }}
          >
            {label}
            <small>{total}</small>
          </button>
        ))}
        {!board && (
          <button
            className="deal-plan-typical"
            type="button"
            onClick={() => {
              setLengths(true);
              setOpened(undefined);
            }}
          >
            Typical lengths
          </button>
        )}
        <button
          type="button"
          aria-pressed={recorded}
          onClick={() => {
            setRecorded(!recorded);
            setReveal(undefined);
          }}
        >
          Recorded only
        </button>
      </aside>
      <div className="deal-plan-chart">
        <Timeline
          {...range(groups, today)}
          key={foldKey}
          foldKey={foldKey}
          today={today}
          groups={displayed.groups}
          links={displayed.links}
          board={board}
          toolsHost={props.mode === "board" ? props.toolsHost : undefined}
          reveal={reveal}
          onOpen={(id) => {
            openedDate.current = (day) => changeDate(id, day);
            openedStepVersion.current = sourceSteps.get(id)?.change_id ?? null;
            setOpened(id);
            setEdit(undefined);
            setLengths(false);
          }}
          controls={controls}
          changeDate={
            props.canSave && !busy
              ? {
                  source: (id) => rowsById.get(id),
                  preview,
                  show: (day) => {
                    setPreview(day);
                    setReveal(undefined);
                  },
                  begin: (id) => (day) => changeDate(id, day),
                  canMove: (row) =>
                    row.kind === "step"
                      ? row.state === "open" && sourceSteps.get(row.id)?.change_id != null
                      : version != null && row.kind === "todo" && row.state === "expected" && row.start !== row.end,
                }
              : undefined
          }
        />
        <div className="deal-plan-count">{groups.length ? count : "No matching items"}</div>
        {(!board || status) && (
          <footer className="deal-plan-footer">
            {status ? (
              <small role="status">{status}</small>
            ) : (
              <>
                <span>Recorded</span>
                <span>Expected</span>
              </>
            )}
            {undo && (
              <button
                type="button"
                className="btn btn-quiet"
                disabled={busy}
                onClick={() => void update(undo.path, undo.args, undo.label)}
              >
                Undo
              </button>
            )}
            {planPath && props.canSave && version != null && Object.keys(own).length > 0 && (
              <button type="button" className="btn btn-quiet" onClick={() => setReset(true)}>
                Reset to typical
              </button>
            )}
          </footer>
        )}
      </div>
      {selected && (
        <section className="deal-plan-details" aria-label={selected.name}>
          <button type="button" className="btn btn-quiet" aria-label="Close item" onClick={() => setOpened(undefined)}>
            ×
          </button>
          <h3>{selected.name}</h3>
          <p>{selected.kind === "step" ? selected.owner : PHASES[selected.phase]}</p>
          {rowDay(selected) && <p>{dayText(rowDay(selected) ?? today, today)}</p>}
          {selected.kind === "todo" && selectedFacts?.kind === "todo" && selectedFacts.typical_days != null && (
            <p>Typical length {selectedFacts.typical_days} days</p>
          )}
          {props.canSave && canSetDate && (
            <button className="btn" type="button" onClick={() => setEdit("date")}>
              {selected.kind === "todo" ? "Set your own date" : "Change date"}
            </button>
          )}
          {props.canSave && selectedFacts?.kind === "step" && selectedFacts.state !== "done" && stepVersion != null && (
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() =>
                void update(
                  `next-steps/${selectedFacts.id.slice(5)}/end`,
                  { resolution: "done", base_version: stepVersion },
                  "Step marked done.",
                )
              }
            >
              Mark done
            </button>
          )}
          {props.canSave && selectedFacts?.kind === "critical_date" && selectedFacts.status !== "cleared" && (
            <>
              {selectedFacts.status === "proposed" ? (
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void update(`critical-dates/${selectedFacts.id.slice(14)}/confirm`, {}, "Critical date confirmed.")
                  }
                >
                  Confirm
                </button>
              ) : (
                <button className="btn" type="button" onClick={() => setEdit("done")}>
                  Mark done
                </button>
              )}
              <button className="btn" type="button" onClick={() => setEdit("drop")}>
                Drop
              </button>
            </>
          )}
          {edit === "date" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                openedDate.current?.(String(new FormData(event.currentTarget).get("day")));
              }}
            >
              <label>
                New date
                <input
                  required
                  type="date"
                  name="day"
                  min={"start" in selected && selected.start > today ? selected.start : today}
                  defaultValue={rowDay(selected) ?? undefined}
                />
              </label>
              <button className="btn" type="submit" disabled={busy}>
                Save date
              </button>
            </form>
          )}
          {(edit === "drop" || edit === "done") && selectedFacts?.kind === "critical_date" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const reason = String(new FormData(event.currentTarget).get("reason")).trim();
                if (reason)
                  void update(
                    `critical-dates/${selectedFacts.id.slice(14)}/resolve`,
                    { resolution: edit === "drop" ? "dropped" : "done", reason },
                    edit === "drop" ? "Critical date dropped." : "Critical date marked done.",
                  );
              }}
            >
              <label>
                Reason
                <input name="reason" required maxLength={500} />
              </label>
              <button className="btn" type="submit" disabled={busy}>
                {edit === "drop" ? "Drop date" : "Mark date done"}
              </button>
            </form>
          )}
        </section>
      )}
      {reset && planPath && (
        <section className="deal-plan-details" aria-label="Reset to typical">
          <p>Clear all dates you set for this deal?</p>
          <button className="btn" type="button" onClick={() => setReset(false)}>
            Cancel
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setReset(false);
              void update(planPath, { base_version: version }, "Typical lengths restored.");
            }}
          >
            Reset to typical
          </button>
        </section>
      )}
      {lengths && props.mode === "plan" && (
        <TypicalLengths
          kind={props.kind ?? "lease"}
          request={props.request}
          reload={props.reload}
          canSave={props.canSave}
          close={() => setLengths(false)}
        />
      )}
    </div>
  );
}

export function mountDealPlan(host: HTMLElement) {
  const root = createRoot(host);
  return {
    update(input: Inputs) {
      flushSync(() => root.render(<PlanScreen key={input.mode === "plan" ? input.deal : "board"} {...input} />));
    },
    dispose() {
      root.unmount();
    },
  };
}
