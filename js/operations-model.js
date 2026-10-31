// Governance and scheduler contracts shared by the Control Room and Home.
const isText = (value) => typeof value === "string" && value.length > 0;
const isTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const orNull = (value, check) => value === null || value === undefined || check(value);

/** The three lanes, in the order the producer returns them, each with the verb that decides it. */
export const GOVERNANCE_LANES = Object.freeze([
  { id: "pending_rule_approvals", label: "Taught rules awaiting approval", verb: "approve-rule", idField: "rule_id", sinceField: "admitted_at" },
  { id: "pending_guidance_import_batches", label: "Guidance import batches awaiting a decision", verb: "decide-guidance-import-batch", idField: "batch_id", sinceField: "staged_at" },
  { id: "pending_retrieval_proposals", label: "Retrieval proposals awaiting approval", verb: "approve-retrieval-proposals", idField: "proposal_id", sinceField: "proposed_at" },
]);

/** `governance-queue`'s own shape: three lanes and counts that agree with them. */
export function validGovernanceQueuePayload(payload) {
  if (!payload || typeof payload !== "object" || payload.ok !== true) return false;
  const counts = payload.counts;
  if (!counts || typeof counts !== "object") return false;
  let total = 0;
  for (const lane of GOVERNANCE_LANES) {
    const rows = payload[lane.id];
    if (!Array.isArray(rows) || counts[lane.id] !== rows.length) return false;
    total += rows.length;
    if (!rows.every((row) => row && typeof row === "object"
      && isText(row[lane.idField]) && orNull(row[lane.sinceField], isTime))) return false;
  }
  if (payload.pending_convention_proposals !== undefined) {
    const rows = payload.pending_convention_proposals;
    if (!Array.isArray(rows) || counts.pending_convention_proposals !== rows.length
      || !rows.every(row => row && isText(row.section_id) && isText(row.section_key)
        && Number.isInteger(row.base_version) && row.base_version > 0
        && orNull(row.updated_at, isTime)
        && (row.adoptable === false ? isText(row.problem) : row.adoptable === true
          && isText(row.statement) && orNull(row.card_id, isText)
          && Array.isArray(row.packs) && row.packs.every(isText)
          && row.approve_with?.verb === 'adopt-rule' && isText(row.approve_with.section_id)
          && Number.isInteger(row.approve_with.base_version) && row.approve_with.base_version > 0))) return false;
    total += rows.length;
  }
  return Number.isInteger(counts.total) && counts.total === total;
}

const SCHEDULE_OWNERS = ["launchd", "claude-code", "cron"];
const SCHEDULE_STATES = ["healthy", "missed", "failed", "paused", "running", "unknown"];

/** A schedule timestamp needs its day as well as its local AM/PM clock. */
export function formatScheduleDateTime(at, options = {}) {
  if (!isTime(at)) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
    ...options,
  }).format(new Date(at));
}

/** The pinned schedule-board/v1 read, including source coverage. */
export function validScheduleBoardPayload(payload) {
  if (!payload || payload.ok !== true || payload.schema !== "schedule-board/v1"
      || !isTime(payload.observed_at) || !["read", "attention", "unknown"].includes(payload.overall_state)
      || !Array.isArray(payload.sources) || !Array.isArray(payload.jobs)) return false;
  if (payload.sources.length !== SCHEDULE_OWNERS.length) return false;
  for (const owner of SCHEDULE_OWNERS) {
    const source = payload.sources.find((row) => row?.owner === owner);
    const count = payload.jobs.filter((job) => job?.owner === owner).length;
    if (!source || !["read", "unknown"].includes(source.state)
        || source.count !== (count || null) || (count === 0 && source.state !== "unknown")) return false;
  }
  const keys = new Set();
  for (const job of payload.jobs) {
    if (!job || !isText(job.key) || !isText(job.name) || !SCHEDULE_OWNERS.includes(job.owner)
        || !SCHEDULE_STATES.includes(job.state) || !["fresh", "stale", "unknown"].includes(job.freshness)
        || !isText(job.schedule) || !orNull(job.next_due_at, isTime)
        || ![null, "cadence_deadline", "queued_job"].includes(job.next_due_basis)
        || Boolean(job.next_due_at) !== Boolean(job.next_due_basis)
        || !job.actions || job.actions.pause !== false || job.actions.run !== false || job.actions.stop !== false
        || (job.last_run && (!isTime(job.last_run.at) || !isText(job.last_run.receipt_ref)))
        || keys.has(`${job.owner}:${job.key}`)) return false;
    keys.add(`${job.owner}:${job.key}`);
  }
  return true;
}

const CONVENTION_RECEIPT_FIELDS = [
  'ok', 'rule_id', 'card_id', 'load_layer', 'packs', 'approval',
  'retired_rule_ids', 'retired_section_id', 'attach_id', 'generation',
];
const CONVENTION_APPROVAL_FIELDS = [
  'ok', 'replayed', 'rule_id', 'policy_status', 'enforcement_status',
  'installed_controls', 'pending_controls', 'approval_receipt_id',
];
const isUuid = value => typeof value === 'string' && value.length === 36
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const listOf = (value, check) => Array.isArray(value) && Array.from(value).every(check);
const sortedUnique = values => values.every((value, index) => index === 0 || values[index - 1] < value);
function hasReceiptFields(value, fields, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && fields.every(field => Object.hasOwn(value, field))
    && Object.keys(value).every(field => fields.includes(field) || optional.includes(field));
}

export function validConventionAdoptionReceipt(receipt, sectionId) {
  if (!hasReceiptFields(receipt, CONVENTION_RECEIPT_FIELDS, ['replayed'])
      || receipt.ok !== true || !isUuid(sectionId) || receipt.retired_section_id !== sectionId
      || !isUuid(receipt.attach_id) || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1
      || (Object.hasOwn(receipt, 'replayed') && receipt.replayed !== true)
      || !listOf(receipt.retired_rule_ids, isUuid) || !sortedUnique(receipt.retired_rule_ids)
      || !listOf(receipt.packs, isText) || !sortedUnique(receipt.packs)) return false;
  if (receipt.rule_id === null) {
    return receipt.retired_rule_ids.length > 0 && receipt.card_id === null
      && receipt.load_layer === null && receipt.packs.length === 0 && receipt.approval === null;
  }
  if (!isUuid(receipt.rule_id) || receipt.retired_rule_ids.includes(receipt.rule_id)) return false;
  const delivery = receipt.card_id === null
    ? receipt.load_layer === 'pack' && receipt.packs.length > 0
    : isText(receipt.card_id) && receipt.load_layer === 'control' && receipt.packs.length === 0;
  const approval = receipt.approval;
  return delivery && hasReceiptFields(approval, CONVENTION_APPROVAL_FIELDS)
    && approval.ok === true && approval.replayed === false && approval.rule_id === receipt.rule_id
    && approval.policy_status === 'active' && approval.enforcement_status === 'authority_enforced'
    && Array.isArray(approval.installed_controls) && approval.installed_controls.length === 1
    && approval.installed_controls[0] === 'human_authority_runtime'
    && Array.isArray(approval.pending_controls) && approval.pending_controls.length === 0
    && isUuid(approval.approval_receipt_id);
}
