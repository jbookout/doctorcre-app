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
//   1. The phases follow the record layer's own `deal_phase` order, and the
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
  { slug: 'pending', value: 'On Deck', label: 'Prospective Client' },
  { slug: 'research', value: 'Research', label: 'Research' },
  { slug: 'site_selection', value: 'Site selection', label: 'Site Selection' },
  { slug: 'negotiation', value: 'Negotiation', label: 'Negotiating' },
  { slug: 'legal', value: 'Legal', label: 'Legal' },
  { slug: 'due_diligence', value: 'Diligence', label: 'Due Diligence' },
  { slug: 'closing', value: 'Closing', label: 'Closing' },
  { slug: 'closed', value: 'Closed', label: 'Closed' },
].map((column) => Object.freeze(column)));

/** Phase destinations on the open board. Closing remains available in deal details. */
export const OPEN_COLUMNS = Object.freeze(COLUMNS.filter(column => column.slug !== 'closed'));

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
 * Group the board's rows into the seven open columns, in table order.
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
  const columns = OPEN_COLUMNS.map((column) => ({ ...column, deals: [] }));
  const byValue = new Map(columns.map((column) => [column.value, column]));
  const unplaced = [];
  for (const deal of rows) {
    if (!deal || typeof deal !== 'object') continue;
    const column = byValue.get(deal.phase);
    if (column) column.deals.push(deal);
    else if (deal.phase !== 'Closed' && deal.phase !== 'closed') unplaced.push(deal);
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
 * keeps every record whose outcome is NULL — so the card would land in Closed
 * with nothing said about how it ended. `update-deal` is now pinned on this
 * app's interface, so the Closed dialog collects the outcome and the closing
 * date and writes them, and this sentence says exactly what will be written.
 * It still claims no gate: CARR checks the outcome against its own enum and
 * nothing else.
 */
export function closedColumnCaption() {
  return 'Records the outcome and the closing date on the deal.';
}

/**
 * The three outcomes the record layer accepts, and nothing else.
 *
 * `deal_outcome_check` constrains the column to exactly these values, so the
 * dialog offers exactly these values. A fourth chip here would be a write the
 * database refuses after the phase has already moved.
 */
export const DEAL_OUTCOMES = Object.freeze([
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'paused', label: 'Paused' },
].map((entry) => Object.freeze(entry)));

/** The slug of the one column that records an outcome. */
export const CLOSED_SLUG = 'closed';

/** Is this outcome one the record layer will take? */
export function isDealOutcome(value) {
  return DEAL_OUTCOMES.some((entry) => entry.value === value);
}

/** The captions the dialog prints. No sentence here promises a check. */
export const COMPLETION_CAPTIONS = Object.freeze({
  evidence: 'Filed as a note on the record. CARR does not require evidence to move a phase.',
  change_reason: 'A short reason, saved with the phase change itself.',
  human_quote: 'Your own sentence, saved word for word with the phase change.',
  next: 'Recorded as the next step.',
  effective_off: 'Not recorded anywhere; the move is dated by when it is saved.',
  effective_on: 'Recorded as a critical date on the record.',
  outcome: 'Outcome',
  closed_on: 'The date the record closed, written alongside the outcome.',
  won_value: 'Optional. Recorded only on a won outcome.',
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
 * A move INTO Closed carries one more step, and it is deliberately LAST: the
 * outcome is a second write on a record the phase patch has already moved, it
 * needs a `base_version` read fresh AFTER that patch, and a refusal on it must
 * leave the card where the server put it. The plan names the step and the
 * fields; the caller supplies `base_version` at the moment it sends, because a
 * version this module captured would already be stale by then.
 *
 * @param {ReturnType<typeof moveIntent>} intent
 * @param {{evidence?:string, nextStep?:string, nextWhen?:string,
 *          effectiveDate?:string, recordCriticalDate?:boolean, dateSource?:string,
 *          outcome?:string, closedOn?:string, wonValue?:string|number,
 *          changeReason?:string, humanQuote?:string}} [form]
 * @returns {{steps: Array<{verb:string, args:Object, summary:string}>, errors: string[]}}
 */
export function completionPlan(intent, form = {}) {
  const errors = [];
  if (!intent) return { steps: [], errors: ['There is no move to make.'] };

  // The reason and the partner's own sentence ride ON the phase patch rather
  // than as follow-up verbs: they describe the change itself, so they belong to
  // the same write and the same receipt. Blank stays blank — an untouched box
  // sends no key at all, never an empty string.
  const phaseArgs = { deal: intent.deal, field: 'phase', value: intent.value };
  const changeReason = text(form.changeReason);
  const humanQuote = text(form.humanQuote);
  if (changeReason) phaseArgs.change_reason = changeReason;
  if (humanQuote) phaseArgs.human_quote = humanQuote;

  const steps = [{
    verb: 'patch-deal-field',
    args: phaseArgs,
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
    const words = nextStep.split(/\s+/u).length;
    if (words < 2 || words > 4 || nextStep.length > 100) errors.push('Use 2–4 words for the next item title.');
    else steps.push({
      verb: 'record-deal-item',
      args: { deal: intent.deal, title: nextStep, due_on: nextWhen || null, bullets: [{ date: null, kind: 'promised', text: nextStep }] },
      summary: `Next item on ${intent.name}`,
    });
  } else if (nextWhen) {
    errors.push('A date for what happens next needs the step itself; type what happens next, or clear the date.');
  }

  const effective = text(form.effectiveDate);
  const source = text(form.dateSource);
  if (form.recordCriticalDate === true) {
    if (!effective) errors.push('Pick the effective date, or clear the critical-date box.');
    if (!source) errors.push('Enter a date reference.');
    if (effective && source) {
      steps.push({
        verb: 'add-critical-date',
        args: { deal: intent.deal, kind: PHASE_DATE_KIND, due_on: effective, source },
        summary: `Critical date on ${intent.name}`,
      });
    }
  }

  if (intent.to === CLOSED_SLUG) {
    const outcome = text(form.outcome);
    if (!outcome) {
      errors.push('Choose the outcome — Won, Lost or Paused — before closing this record.');
    } else if (!isDealOutcome(outcome)) {
      errors.push('Select won, lost, or paused.');
    } else {
      const fields = { outcome };
      const closedOn = text(form.closedOn);
      if (closedOn) fields.closed_on = closedOn;
      // The money only belongs to a won record. A value typed against Won and
      // then switched to Lost is DROPPED here rather than written, because a
      // lost deal with a won value on it is a record nobody can read honestly.
      if (outcome === 'won') {
        const raw = text(form.wonValue);
        if (raw) {
          const amount = Number(raw);
          if (!Number.isFinite(amount)) errors.push('The won value must be a number, or leave it empty.');
          else fields.won_value = amount;
        }
      }
      if (!errors.length) {
        steps.push({
          verb: 'update-deal',
          args: { deal: intent.deal, fields },
          summary: `Outcome ${outcome} on ${intent.name}`,
        });
      }
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

// A note or next step can reach this board as a sentence, an object such as
// {text, at}, or that object's Python repr printed into a string
// ("{'text': '...', 'at': '...'}"). Cards and the panel show the sentence only.
const NOTE_KEYS = ['text', 'note', 'body', 'summary', 'content', 'message'];
const PY_ESCAPES = { n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"' };

function dictSentence(raw) {
  try {
    return noteText(JSON.parse(raw));
  } catch { /* not JSON; try the Python repr */ }
  for (const key of NOTE_KEYS) {
    const match = new RegExp(`['"]${key}['"]\\s*:\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(raw);
    if (match) return match[2].replace(/\\(.)/g, (_, ch) => PY_ESCAPES[ch] ?? ch).trim();
  }
  return '';
}

// A name written as a structured value ({"value":"…"}, seen on staging) reads
// as its text; anything else falls through to the note rules.
export function dealName(value) {
  const wrapped = typeof value === 'string' && /^\s*\{\s*"value"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(value);
  const text = wrapped ? JSON.parse(`"${wrapped[1]}"`).trim() : noteText(value);
  return text || 'Untitled deal';
}

/**
 * The sentence a note value carries, or '' when it carries none. A string
 * shaped like a dict never paints as raw braces.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function noteText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    for (const key of NOTE_KEYS) {
      const inner = noteText(value[key]);
      if (inner) return inner;
    }
    return '';
  }
  const text = String(value).trim();
  if (/^\{[\s\S]*\}$/.test(text) && (text === '{}' || /^\{\s*['"]/.test(text))) return dictSentence(text);
  return text;
}

/* --------------------------------------------------------- V5-UX-B04: context */

// deal_participant carries five roles. 'lead' and 'support' are internal team
// assignment (actor_id, no party_id); these three carry an external party_id
// and are what the context
// drawer means by "attached parties/vendors".
const EXTERNAL_PARTY_ROLES = ['client_contact', 'referring_agent', 'listing_side'];
const PARTY_ROLE_LABEL = {
  client_contact: 'Client contact',
  referring_agent: 'Referring agent',
  listing_side: 'Listing side',
};

/** The word for a deal_participant role; the wire value itself when unmapped. */
export function partyRoleLabel(role) {
  return PARTY_ROLE_LABEL[role] || role || 'Party';
}

/**
 * The attached parties/vendors on a deal — the external `deal_participant`
 * rows, exactly as `get-deal-room` returned them. Never filled in from a
 * second read: their contact detail is not addressable here (see
 * `loadDealContext`), so this stays a name-and-role list.
 */
export function attachedParties(participants = []) {
  return participants.filter((row) => EXTERNAL_PARTY_ROLES.includes(row?.role));
}

/** Read exact client identity and recorded vendor-to-deal evidence only. */
export async function loadDealContext(client, detail) {
  const deal = detail?.deal || {};
  const id = deal.client_id || deal.account_client_id;
  let record = null;
  const status = id ? 'unavailable' : 'not_linked';
  if (id && client?.getPartyRecord) {
    try { record = (await client.getPartyRecord({dataset:'clients',id}))?.record || null; } catch { /* Optional context stays hidden when unreadable. */ }
  }
  let vendors = [];
  if (client?.getRelationshipNetwork && deal.id) {
    try {
      const network = await client.getRelationshipNetwork();
      const linked = new Set((network.edges || []).filter(e => e.to === `deal:${deal.id}` && e.kind !== 'client_deal').map(e => e.from));
      vendors = (network.nodes || []).filter(n => n.kind === 'vendor' && linked.has(n.id));
    } catch { /* The card remains usable without optional network context. */ }
  }
  if (record && !record.id) record = {...record,id};
  return {client: record ? {status:'ok',record} : {status,reason:id ? 'fetch_failed' : undefined}, vendors,
    parties:attachedParties(detail?.participants || []),criticalDates:detail?.critical_dates || []};
}
export function contextDrawerSections(context, options = {}) {
  const sections = [];
  const record = context?.client?.record;
  if (record) sections.push({title:'Client',links:record.id ? [{label:'Open client record',href:`/clients?record=${encodeURIComponent(record.id)}`}] : [],lines:[record.name,
    [record.title,record.phone,record.cell,record.email].filter(Boolean).join(' · '),
    [record.city,record.state].filter(Boolean).join(', ')].filter(Boolean)});
  const parties = context?.parties || [];
  if (parties.length) sections.push({title:'Attached parties',lines:parties.map(p => `${partyRoleLabel(p.role)} · ${p.name}`)});
  if (context?.vendors?.length) sections.push({title:'Vendors',links:context.vendors.filter(v=>v.record_id).map(v=>({label:`Open ${v.name}`,href:`/vendors?record=${encodeURIComponent(v.record_id)}`})),lines:context.vendors.map(v => [v.name,v.territory,v.summary].filter(Boolean).join(' · '))});
  if (!sections.length) return sections;
  const date = options.dateLabel || String;
  if (context?.criticalDates?.length) sections.push({title:'Critical dates',lines:context.criticalDates.map(d => `${d.label || d.kind} · ${date(d.date || d.due_on)}${d.source ? ` · ${d.source}` : ''}`)});
  return sections;
}

export function dealInsightLines(reading) {
  if (!reading?.judged) return [reading?.reason === 'insufficient_recorded_evidence' ? 'Insufficient evidence' : 'Insights unavailable'];
  return [`Movement ${reading.movement_rung} of ${reading.movement_rungs}`, reading.movement_label,
    `Waiting on: ${String(reading.waiting_on || 'not recorded').replaceAll('_', ' ')}`,
    `Estimated silence concern: ${Math.round(Number(reading.silence_is_bad) * 100)}%`];
}
