// V5-UX-B03 — the Deals board's decisions, with no DOM in sight.
//
// Everything this module answers is a question about records and words: which
// columns exist and in what order, which column a record sits in, what a move
// would send, which of the optional follow-ups the person actually filled in,
// and what each of those says in the dock. js/pipeline.js does the painting and
// the sending; it decides nothing that is written down here.
//
// Two rules shape the file:
//
//   1. The eight columns are the record layer's own `deal_phase` order, and the
//      map between a phase slug and what a person reads is ONE-TO-ONE. The map
//      that shipped before this slice sent two different phases — `research`
//      and `site_selection` — to a single board label, so writing that label
//      back relocated a site-selection deal into research (defect 5e355b84).
//      A round trip through this table returns the slug it started from.
//   2. Nothing here claims a gate. CARR checks a phase change for a non-empty
//      value and an existing record and NOTHING else: no transition table, no
//      precondition, no required evidence. The completion dialog therefore
//      collects things that have honest homes — a note, a next step, a critical
//      date — and says so in those words. A sentence that implied permission
//      would be a lie about the server.

/**
 * @typedef {Object} PipelineColumn
 * @property {string} slug the record layer's `deal_phase` value
 * @property {string} value the client interface's UI phase (js/client.js PHASES)
 * @property {string} label what a person reads on the board
 */

/**
 * The eight phases, in the table's order.
 *
 * `value` is what the client interface already speaks, because the board read,
 * the write and the fixture's own validation all go through it; `label` is what
 * the Kanban prints. They differ in exactly two places, and deliberately: the
 * Deal Room table at /deals has shown "On Deck" and "Diligence" for as long as
 * it has existed and its markup is pinned by several suites, so this surface
 * displays the phase's own name over the client's value rather than renaming a
 * shipped column out from under those tests.
 *
 * @type {readonly PipelineColumn[]}
 */
export const COLUMNS = Object.freeze([
  { slug: 'pending', value: 'On Deck', label: 'Pending' },
  { slug: 'research', value: 'Research', label: 'Research' },
  { slug: 'site_selection', value: 'Site selection', label: 'Site selection' },
  { slug: 'negotiation', value: 'Negotiation', label: 'Negotiation' },
  { slug: 'legal', value: 'Legal', label: 'Legal' },
  { slug: 'due_diligence', value: 'Diligence', label: 'Due diligence' },
  { slug: 'closing', value: 'Closing', label: 'Closing' },
  { slug: 'closed', value: 'Closed', label: 'Closed' },
].map((column) => Object.freeze(column)));

/** The column whose slug is this, or null. Never a guess. */
export function columnBySlug(slug) {
  return COLUMNS.find((column) => column.slug === slug) || null;
}

/** The column whose UI phase value is this, or null. */
export function columnByValue(value) {
  return COLUMNS.find((column) => column.value === value) || null;
}

/** What a person should read for a UI phase value; the value itself if unknown. */
export function columnLabel(value) {
  return columnByValue(value)?.label || String(value ?? '');
}

/**
 * Group the board's rows into the eight columns, in table order.
 *
 * A record whose phase is not one of the eight is NOT dropped and NOT filed
 * under a guess: it is returned separately, so the page can say that the board
 * holds something this surface cannot place instead of quietly hiding it.
 *
 * @param {Array<Object>} deals
 * @returns {{columns: Array<PipelineColumn & {deals: Object[]}>, unplaced: Object[]}}
 */
export function groupByColumn(deals) {
  const rows = Array.isArray(deals) ? deals : [];
  const columns = COLUMNS.map((column) => ({ ...column, deals: [] }));
  const byValue = new Map(columns.map((column) => [column.value, column]));
  const unplaced = [];
  for (const deal of rows) {
    if (!deal || typeof deal !== 'object') continue;
    const column = byValue.get(deal.phase);
    if (column) column.deals.push(deal);
    else unplaced.push(deal);
  }
  return { columns, unplaced };
}

/**
 * What a drop would change, or null when it would change nothing.
 *
 * The value is the client interface's UI phase, because that is the vocabulary
 * `patchDealField` takes in both adapters; the slug travels alongside it so a
 * caller can name the column without translating back.
 *
 * @param {Object} deal a board row
 * @param {string} toSlug the target column's `deal_phase`
 */
export function moveIntent(deal, toSlug) {
  if (!deal || !deal.id) return null;
  const to = columnBySlug(toSlug);
  if (!to) return null;
  const from = columnByValue(deal.phase);
  if (from && from.slug === to.slug) return null;
  return Object.freeze({
    deal: deal.id,
    name: deal.name || 'this record',
    field: 'phase',
    value: to.value,
    from: from ? from.slug : null,
    from_label: from ? from.label : String(deal.phase ?? 'an unplaced phase'),
    to: to.slug,
    to_label: to.label,
  });
}

/** The move, said the way a person reading a receipt would say it. */
export function moveSummary(intent) {
  if (!intent) return '';
  return `${intent.name} → ${intent.to_label}`;
}

/** The title the completion dialog carries. */
export function moveTitle(intent) {
  return intent ? `Move ${intent.name} to ${intent.to_label}` : 'Move';
}

/**
 * The one extra sentence the Closed column owes.
 *
 * A phase patch to `closed` leaves the deal's outcome NULL, and the board view
 * keeps every record whose outcome is NULL — so the card lands in Closed and
 * the record stays on the board. Recording the outcome needs `update-deal`,
 * which is not on this app's interface allowlist, so the honest thing is to say
 * what this move does and does not do.
 */
export function closedColumnCaption() {
  return 'Moving here does not close the deal record; it stays on the board until the outcome is recorded.';
}

/** The captions the dialog prints. No sentence here promises a check. */
export const COMPLETION_CAPTIONS = Object.freeze({
  evidence: 'Filed as a note on the record. CARR does not require evidence to move a phase.',
  next: 'Recorded as the next step.',
  effective_off: 'Not recorded anywhere; the move is dated by when it is saved.',
  effective_on: 'Recorded as a critical date on the record.',
});

/** The `kind` a critical date created by a phase move carries. */
export const PHASE_DATE_KIND = 'phase_effective_date';

const text = (value) => String(value ?? '').trim();

/**
 * The ordered writes one Move would make, and the reasons it cannot be made.
 *
 * The phase patch is ALWAYS first and always present: it is the move, and the
 * follow-ups are things a person chose to record alongside it. Each follow-up
 * appears only when it was filled in, and each is its own verb with its own
 * summary because each gets its own idempotency key and its own receipt — a
 * note that fails must never un-move a card the server already moved.
 *
 * The only refusal is the one the record layer itself would make: `add-critical-date`
 * requires a source, so asking for the date without saying where it came from is
 * named here rather than sent and bounced.
 *
 * @param {ReturnType<typeof moveIntent>} intent
 * @param {{evidence?:string, nextStep?:string, nextWhen?:string,
 *          effectiveDate?:string, recordCriticalDate?:boolean, dateSource?:string}} [form]
 * @returns {{steps: Array<{verb:string, args:Object, summary:string}>, errors: string[]}}
 */
export function completionPlan(intent, form = {}) {
  const errors = [];
  if (!intent) return { steps: [], errors: ['There is no move to make.'] };

  const steps = [{
    verb: 'patch-deal-field',
    args: { deal: intent.deal, field: 'phase', value: intent.value },
    summary: moveSummary(intent),
  }];

  const evidence = text(form.evidence);
  if (evidence) {
    steps.push({
      verb: 'add-deal-note',
      args: { deal: intent.deal, text: evidence },
      summary: `Note on ${intent.name}`,
    });
  }

  const nextStep = text(form.nextStep);
  const nextWhen = text(form.nextWhen);
  if (nextStep) {
    steps.push({
      verb: 'set-next-step',
      args: { deal: intent.deal, text: nextStep, next_date: nextWhen || null },
      summary: `Next step on ${intent.name}`,
    });
  } else if (nextWhen) {
    errors.push('A date for what happens next needs the step itself; type what happens next, or clear the date.');
  }

  const effective = text(form.effectiveDate);
  const source = text(form.dateSource);
  if (form.recordCriticalDate === true) {
    if (!effective) errors.push('Pick the effective date, or clear the critical-date box.');
    if (!source) errors.push('Say where the date came from; the record layer records a critical date only with its source.');
    if (effective && source) {
      steps.push({
        verb: 'add-critical-date',
        args: { deal: intent.deal, kind: PHASE_DATE_KIND, due_on: effective, source },
        summary: `Critical date on ${intent.name}`,
      });
    }
  }

  return { steps, errors };
}

/**
 * The column the arrow keys choose next, wrapping at both ends.
 *
 * Right and Down step forward, Left and Up step back — the same pairing the
 * prototype used, because a board that scrolls sideways is read both ways.
 * Anything else returns null, which the caller reads as "this key is not mine".
 *
 * @param {string} current the slug currently chosen
 * @param {string} key a KeyboardEvent key
 * @param {readonly PipelineColumn[]} [columns]
 * @returns {string|null}
 */
export function keyboardTarget(current, key, columns = COLUMNS) {
  const list = Array.isArray(columns) ? columns : [];
  if (list.length === 0) return null;
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1
    : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (step === 0) return null;
  const index = list.findIndex((column) => column.slug === current);
  const from = index < 0 ? 0 : index;
  return list[(from + step + list.length) % list.length].slug;
}

/**
 * What a partner's open lease on this record says, or null.
 *
 * Only a lease belonging to someone else is a chip: a person does not need to be
 * told they are editing. Nothing is inferred about what the partner will do.
 *
 * @param {Array<Object>} presence leases as the changes feed returns them
 * @param {string} dealId
 * @param {{selfActor?:string|null, field?:string|null, actorLabel?:(slug:string)=>string}} [options]
 */
export function presenceChip(presence, dealId, options = {}) {
  const leases = Array.isArray(presence) ? presence : [];
  const label = options.actorLabel || ((slug) => slug);
  const field = options.field ?? null;
  for (const lease of leases) {
    if (!lease || lease.deal_id !== dealId) continue;
    if (field && lease.field !== field) continue;
    if (options.selfActor && lease.actor === options.selfActor) continue;
    if (!lease.actor) continue;
    return `${label(lease.actor) || lease.actor} is editing`;
  }
  return null;
}

/**
 * The chips over the board, built from what the board actually returns.
 *
 * `deal-room-board` carries a deal `type` (the deal kind: Relocation, Renewal,
 * Startup and so on) and a `segment` (the practice's specialty). It does NOT
 * carry a prospect/client distinction, so this bar cannot offer one without
 * inventing a field. It offers what is there: All, then every type present, in
 * the board's own words.
 */
export function typeFilters(deals) {
  const rows = Array.isArray(deals) ? deals : [];
  const types = [...new Set(rows.map((deal) => text(deal?.type)).filter(Boolean))].sort();
  return [{ value: 'all', label: 'All' }, ...types.map((value) => ({ value, label: value }))];
}

/** Keep the rows this filter names. "all" — and an unknown filter — keep them all. */
export function filterDeals(deals, filter) {
  const rows = Array.isArray(deals) ? deals : [];
  if (!filter || filter === 'all') return [...rows];
  return rows.filter((deal) => text(deal?.type) === filter);
}

/** Cards inside a column, newest attention first, then by name. Stable. */
export function orderColumn(deals) {
  return [...(Array.isArray(deals) ? deals : [])].sort((a, b) => {
    const attention = Number(Boolean(b?.attention)) - Number(Boolean(a?.attention));
    if (attention !== 0) return attention;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });
}

/**
 * The sections of the record side panel, in the order Joe's review fixed them.
 *
 * Every value traces to the detail read. A section with nothing recorded says so
 * in plain words; none of them is filled in from somewhere else, and the Doc
 * section states its scope rather than showing work that does not exist yet.
 *
 * @param {Object} detail the answer from `getDeal`
 * @param {{actorLabel?:(slug:string)=>string, dateLabel?:(value:string)=>string}} [options]
 */
export function recordPanelSections(detail, options = {}) {
  const deal = detail?.deal || {};
  const label = options.actorLabel || ((slug) => slug || 'Unassigned');
  const date = options.dateLabel || ((value) => String(value ?? ''));

  const situation = [
    deal.name || 'This record',
    deal.type ? `${deal.type}` : null,
    deal.phase ? `${columnLabel(deal.phase)}` : null,
    `owned by ${label(deal.owner)}`,
    deal.attention ? 'flagged for attention' : null,
  ].filter(Boolean).join(' · ');

  const nextAction = deal.next_step
    ? `${deal.next_step}${deal.next_date ? ` · ${date(deal.next_date)}` : ''}`
    : 'No next step recorded.';

  const criticalDates = (detail?.critical_dates || [])
    .map((entry) => `${entry.label || entry.kind || 'Date'} · ${date(entry.date || entry.due_on)}${entry.source ? ` · source ${entry.source}` : ''}`);

  const latest = (detail?.thread || [])[0] || null;

  return [
    { title: 'Situation', lines: [situation] },
    { title: 'Next action', lines: [nextAction] },
    { title: 'Critical dates', lines: criticalDates.length ? criticalDates : ['None recorded.'] },
    { title: 'Blockers', lines: [deal.attention ? 'Flagged for attention on the record.' : 'None recorded.'] },
    {
      title: 'Latest communication',
      lines: [latest ? `${label(latest.actor)}: ${latest.text}` : 'Nothing captured on this record.'],
    },
    { title: 'Doc work', lines: ['Not in this release.'], state: 'not_in_release' },
  ];
}
